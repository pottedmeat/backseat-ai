import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { StoredActor } from './registry.js'
import type { Summary } from './runtime.js'
import { privateDir, userTemp } from './run.js'
import { readTrace } from './trace.js'

/**
 * Where runs live (ADR-0006). A run is one root actor's
 * directory, `<live>/<rootId>` until the root finishes, `<completed>/<rootId>` after. `BACKSEAT_STATE_DIR` pins one
 * directory as the run instead, as the live-run harness does; a pinned run may hold several roots and never moves.
 */
export type RunsDirs = { live: string; completed: string }

export type UserConfig = { runs?: { live?: string; completed?: string } }

function configHome(): string {
  return resolve(process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config'))
}

function stateHome(): string {
  return resolve(process.env['XDG_STATE_HOME'] || join(homedir(), '.local', 'state'))
}

export function configPath(): string {
  return join(configHome(), 'backseat', 'config.json')
}

function readUserConfig(path = configPath()): UserConfig {
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8')) as UserConfig
}

/** `~` is the home directory; a relative path is relative to the config file, so a checked-in config is portable. */
function expandPath(given: string, base: string): string {
  if (given === '~' || given.startsWith('~/')) return join(homedir(), given.slice(1))
  return isAbsolute(given) ? given : resolve(base, given)
}

export function runsDirs(path = configPath()): RunsDirs {
  const config = readUserConfig(path)
  const base = dirname(path)
  return {
    live: config.runs?.live ? expandPath(config.runs.live, base) : join(privateDir(join(stateHome(), 'backseat')), 'runs'),
    completed: config.runs?.completed ? expandPath(config.runs.completed, base) : join(userTemp(), 'runs'),
  }
}

/**
 * Finds a run's directory from a root id; `undefined` is the run-less place for calls that touch no actor. Pinned,
 * every id resolves to the pinned directory; `runs` is then only where `listRuns` looks besides it.
 */
export type Locator = {
  pinned: string | undefined
  runs: RunsDirs | undefined
  dirOf(rootId: string | undefined): string
}

export function pinnedLocator(dir: string, runs?: RunsDirs): Locator {
  return { pinned: dir, runs, dirOf: () => dir }
}

export function runsLocator(runs: RunsDirs): Locator {
  return {
    pinned: undefined,
    runs,
    dirOf(rootId) {
      if (rootId === undefined) return runs.live
      const live = join(runs.live, rootId)
      if (existsSync(live)) return live
      const completed = join(runs.completed, rootId)
      if (existsSync(completed)) return completed
      return live // a root about to be created, or one that does not exist: the store says which
    },
  }
}

/** What the bins use: the pin when set (listed alongside the configured runs), else the configured runs directories. */
export function defaultLocator(): Locator {
  const pinned = process.env['BACKSEAT_STATE_DIR']
  const runs = runsDirs()
  return pinned ? pinnedLocator(resolve(pinned), runs) : runsLocator(runs)
}

/**
 * Move a finished run from live to completed. Called by the invocation that saw the root reach `done` or `error`, after
 * its trace entry landed. Falls back to copy-and-delete when the two live on different volumes.
 */
export function completeRun(runs: RunsDirs, rootId: string): string | undefined {
  const from = join(runs.live, rootId)
  if (!existsSync(from)) return undefined
  const to = join(runs.completed, rootId)
  mkdirSync(runs.completed, { recursive: true })
  rmSync(to, { recursive: true, force: true })
  try {
    renameSync(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    cpSync(from, to, { recursive: true })
    rmSync(from, { recursive: true, force: true })
  }
  return to
}

type RootStatus = 'active' | 'done' | 'error' | 'unknown'

export type RunInfo = {
  dir: string
  where: 'live' | 'completed' | 'pinned'
  /** `bin` is the tool that created the root. */
  roots: { id: string; machine: string | undefined; status: RootStatus; bin?: string }[]
  started: string | undefined
  lastCall: string | undefined
  calls: number
  /** Children that appeared which no spawn site declared, across the run's calls: the sites the definition still owes. */
  undeclared: number
}

/** Every run the tool can find: live, completed, and the pinned directory when one is set. Newest last call first. */
export function listRuns(locate: Locator): RunInfo[] {
  const found: RunInfo[] = []
  if (locate.pinned) {
    const run = describeRun(locate.pinned, 'pinned')
    if (run) found.push(run)
  }
  if (locate.runs) {
    for (const where of ['live', 'completed'] as const) {
      const root = locate.runs[where]
      if (!existsSync(root)) continue
      for (const name of readdirSync(root)) {
        const dir = join(root, name)
        if (!statSync(dir).isDirectory()) continue
        const run = describeRun(dir, where)
        if (run) found.push(run)
      }
    }
  }
  return found.sort((a, b) => (b.lastCall ?? '').localeCompare(a.lastCall ?? ''))
}

/**
 * Live runs whose last call is older than `days`: what `backseat-ai doctor` proposes to remove. A run with a record but
 * no trace has no last call, so its newest file stands in for one.
 */
export function staleRuns(locate: Locator, days: number, now = Date.now()): RunInfo[] {
  const cutoff = now - days * 24 * 60 * 60 * 1000
  const touched = (run: RunInfo) => (run.lastCall ? Date.parse(run.lastCall) : Math.max(...readdirSync(run.dir).map((name) => statSync(join(run.dir, name)).mtimeMs)))
  return listRuns(locate).filter((run) => run.where === 'live' && touched(run) < cutoff)
}

/**
 * One root actor's record, or nothing. A run directory is not only root records — each root's pin, `<rootId>.pin.json`,
 * sits beside its record — and a file that is not a record (a stray, a half-written one) must be passed over rather
 * than read as a phantom root or thrown on.
 */
function readRecord(path: string): StoredActor | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Partial<StoredActor>
  if (typeof record.machine !== 'string' || typeof record.snapshot !== 'object' || record.snapshot === null) return undefined
  return record as StoredActor
}

function describeRun(dir: string, where: RunInfo['where']): RunInfo | undefined {
  const entries = readTrace(dir)
  const roots = new Map<string, RunInfo['roots'][number]>()
  // The persisted record is the authority on a root's status; the trace fills in for a directory with none (a fixture,
  // or a run whose record was lost).
  const recorded = new Set<string>()
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const record = readRecord(join(dir, name))
    if (!record) continue // not a root's record: a run directory holds other JSON, and a stray file must not read as a root
    const id = name.slice(0, -'.json'.length)
    roots.set(id, { id, machine: record.machine, status: (record.snapshot as { status?: RootStatus }).status ?? 'unknown', ...(record.bin !== undefined && { bin: record.bin }) })
    recorded.add(id)
  }
  for (const entry of entries) {
    if (entry.actorId === undefined || entry.actorId.includes('/') || recorded.has(entry.actorId)) continue
    if (entry.argv[0] === 'create' && entry.exitCode === 0) roots.set(entry.actorId, { id: entry.actorId, machine: entry.argv[1], status: 'unknown' })
    const root = roots.get(entry.actorId)
    const response = entry.response as Partial<Summary> | undefined
    // A summary or a rejection: every response the root printed on exit 0 or 2 says its status.
    if (root && entry.exitCode !== 1 && response && typeof response.status === 'string') root.status = response.status
  }
  if (!entries.length && !roots.size) return undefined
  const last = entries.at(-1)
  return {
    dir,
    where,
    roots: [...roots.values()],
    started: entries[0]?.at,
    lastCall: last ? new Date(Date.parse(last.at) + last.ms).toISOString() : undefined,
    calls: entries.length,
    undeclared: entries.reduce((n, entry) => n + (entry.warnings?.length ?? 0), 0),
  }
}
