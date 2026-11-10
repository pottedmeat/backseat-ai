import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileStore, withLock } from './file-store.js'
import type { StoredActor } from './registry.js'

/**
 * The lock exists so that a call which loads a root, acts and saves it back never saves over a sibling's work. What
 * broke that: a call holding the lock through a 85–92s effect had its lock declared stale by age alone, a sibling wrote
 * its record, and the long call then saved the root it had loaded before — a lost update. So what is asserted is that
 * **a live owner's lock is never taken, and a dead owner's always is.** Timings are shortened through the optional
 * `timing` argument; the rules are the same ones callers get.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('withLock', () => {
  let dir: string
  const lock = () => join(dir, 'root.lock')
  const age = (path: string, ms: number) => {
    const then = new Date(Date.now() - ms)
    utimesSync(path, then, then)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'backseat-lock-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('does not take over a lock whose owner is alive, however old it is', async () => {
    writeFileSync(lock(), JSON.stringify({ pid: process.pid, token: 'other', at: new Date().toISOString() }))
    age(lock(), 60_000) // twice the 30s age rule: the old code took it over here

    let ran = false
    await expect(
      withLock(dir, 'root', async () => {
        ran = true
      }, { timeoutMs: 200 }),
    ).rejects.toThrow(/Timed out waiting for the lock/)
    expect(ran).toBe(false)
  })

  it('takes over a lock whose owner process is dead, without waiting for it to age', async () => {
    const child = spawnSync(process.execPath, ['-e', ''])
    expect(child.pid).toBeGreaterThan(0)
    writeFileSync(lock(), JSON.stringify({ pid: child.pid, token: 'dead', at: new Date().toISOString() }))

    const result = await withLock(dir, 'root', async () => 'ran', { timeoutMs: 500 })
    expect(result).toBe('ran')
  })

  it('keeps its lock fresh while a call outlasts the age rule', async () => {
    const staleMs = 150
    const ages: number[] = []
    await withLock(
      dir,
      'root',
      async () => {
        for (let i = 0; i < 8; i++) {
          await sleep(60)
          ages.push(Date.now() - statSync(lock()).mtimeMs)
        }
      },
      { staleMs, heartbeatMs: 30 },
    )
    // The call ran ~480ms, more than three times staleMs, and the lock never looked abandoned by age.
    expect(Math.max(...ages)).toBeLessThan(staleMs)
  })

  it('makes a sibling wait out a long call, so neither save clobbers the other', async () => {
    const store = fileStore(dir)
    store.put('root', { log: [] } as unknown as StoredActor)
    const timing = { heartbeatMs: 10_000, timeoutMs: 5_000 } // no heartbeat within the call: only the owner's pid holds it
    const append = (entry: string) => {
      const record = store.get('root') as unknown as { log: string[] }
      return () => store.put('root', { log: [...record.log, entry] } as unknown as StoredActor)
    }

    const long = withLock(dir, 'root', async () => {
      const save = append('long') // loaded now
      age(lock(), 60_000) // as a sibling sees it 60s into an effect whose heartbeat has not yet fired
      await sleep(400)
      save()
    }, timing)
    await sleep(150)
    const short = withLock(dir, 'root', async () => append('short')(), timing)
    await Promise.all([long, short])

    expect((store.get('root') as unknown as { log: string[] }).log).toEqual(['long', 'short'])
  })
})
