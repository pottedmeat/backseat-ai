import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { Store, StoredActor } from './registry.js'

/**
 * One JSON file per root actor, `<dirOf(rootId)>/<rootId>.json`. A string is one directory for every root (a pinned
 * run); a function places each root in its own run directory. Writes go through a rename so a reader never sees a
 * torn record.
 */
export function fileStore(dir: string | ((rootId: string) => string)): Store {
  const dirOf = typeof dir === 'string' ? () => dir : dir
  const path = (rootId: string) => join(dirOf(rootId), `${rootId}.json`)
  return {
    get: (id) => (existsSync(path(id)) ? (JSON.parse(readFileSync(path(id), 'utf8')) as StoredActor) : undefined),
    put: (id, record) => {
      mkdirSync(dirOf(id), { recursive: true })
      const tmp = `${path(id)}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(record))
      renameSync(tmp, path(id))
    },
  }
}

/** How a lock is waited for, judged stale and kept fresh. Tests shorten these; callers leave them alone. */
export interface LockTiming {
  pollMs: number
  /** How long a waiter waits on an owner that is still alive before it gives up, loudly. */
  timeoutMs: number
  /** Past this age a lock whose owner cannot be read is taken to be abandoned. */
  staleMs: number
  /** How often the holder refreshes the lock's mtime while its call runs. */
  heartbeatMs: number
}

const LOCK_TIMING: LockTiming = {
  pollMs: 20,
  // An effect run under the lock can take minutes (a search took 85–92s), and a waiter must outlast it.
  timeoutMs: 180_000,
  staleMs: 30_000,
  heartbeatMs: 5_000,
}

/**
 * Serialise invocations that touch one root. Every process rehydrates the root from its file, acts, and writes it back,
 * so two agents driving children of the same root would otherwise overwrite each other's progress.
 *
 * The lock file records its owner `{ pid, token, at }`. A waiter takes it over only when that owner is dead
 * (`process.kill(pid, 0)` fails with `ESRCH`), or — when no pid can be read — when its mtime is older than `staleMs`.
 * While the call runs its holder refreshes the mtime, so age alone never condemns a live call however long it takes.
 * See ADR-0014.
 */
export async function withLock<T>(
  dir: string,
  rootId: string,
  fn: () => Promise<T>,
  timing: Partial<LockTiming> = {},
): Promise<T> {
  const { pollMs, timeoutMs, staleMs, heartbeatMs } = { ...LOCK_TIMING, ...timing }
  const path = join(dir, `${rootId}.lock`)
  const token = randomUUID()
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const fd = openSync(path, 'wx')
      writeSync(fd, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }))
      closeSync(fd)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const held = readLock(path)
      if (!held) continue // released between our open and read
      if (isStale(held, staleMs)) {
        // Remove only the lock that was judged: another waiter may already have replaced it with its own.
        if (readLock(path)?.raw === held.raw) rmSync(path, { force: true })
        continue
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the lock on actor '${rootId}' (${path})`)
      await sleep(pollMs)
    }
  }
  const heartbeat = setInterval(() => {
    try {
      const now = new Date()
      utimesSync(path, now, now)
    } catch {
      // The lock is gone or unreachable; the release below copes, and there is nothing to refresh.
    }
  }, heartbeatMs)
  heartbeat.unref()
  try {
    return await fn()
  } finally {
    clearInterval(heartbeat)
    if (readLock(path)?.token === token) rmSync(path, { force: true })
  }
}

interface HeldLock {
  raw: string
  pid?: number
  token?: string
  mtimeMs: number
}

/** The lock as it stands, or `undefined` when there is none. */
function readLock(path: string): HeldLock | undefined {
  let raw: string
  let mtimeMs: number
  try {
    raw = readFileSync(path, 'utf8')
    mtimeMs = statSync(path).mtimeMs
  } catch {
    return undefined
  }
  let pid: number | undefined
  let token: string | undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const record = parsed as { pid?: unknown; token?: unknown }
      if (typeof record.pid === 'number') pid = record.pid
      if (typeof record.token === 'string') token = record.token
    }
  } catch {
    // Empty (its owner is mid-write) or unreadable: judged by age alone.
  }
  return { raw, pid, token, mtimeMs }
}

function isStale(held: HeldLock, staleMs: number): boolean {
  if (held.pid !== undefined && Number.isInteger(held.pid) && held.pid > 0) return !isAlive(held.pid)
  return Date.now() - held.mtimeMs > staleMs
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists but belongs to someone else. Only ESRCH says it is gone.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
