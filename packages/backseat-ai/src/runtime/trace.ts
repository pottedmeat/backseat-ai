import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withLock } from './file-store.js'
import { PAGE } from './trace-page.js'
import type { Moved } from './runtime.js'

/**
 * One CLI invocation, as the agent saw it. Harness-facing, like `output`: the trace records what the agent did and
 * what it was shown, never XState's internal traffic; the Summary already carries the landing state and the
 * transitions offered next, which is what a reader of the run needs.
 */
export type TraceEntry = {
  /** When the call began, ISO 8601. */
  at: string
  /** Wall time in ms. */
  ms: number
  /**
   * `create`/`send` only: every actor this call moved, with the transitions each took. Harness-facing, never in the
   * response the agent reads: the state an actor rests in cannot tell two guarded transitions to one target apart, show a state passed straight through, or show a
   * transition that acted without moving at all.
   */
  moved?: Moved[]
  /** `create`/`send` only, when any: a child that appeared which no spawn site declares, one line each. */
  warnings?: string[]
  /**
   * `send` only, when the taken transition's effect ran: what it returned, in full, where the response shows only what
   * `data` chose to. Beside a rejection it records an effect that ran for a transition that was then discarded.
   */
  effect?: { output: unknown }
  pid: number
  argv: string[]
  /**
   * `send` only: the payload as the runtime received it, whatever its origin. `argv` alone cannot say, because the
   * stdin form the drive protocol teaches leaves only `-` there.
   */
  payload?: Record<string, unknown>
  /** The actor the call touched: the argument for actor commands, the new id for `create`. */
  actorId?: string
  exitCode: 0 | 1 | 2
  /** Exactly what was printed: the response on 0 and 2, the `{ error }` on 1, `{ error, usage }` for a usage error. */
  response: unknown
}

const TRACE_FILE = 'trace.jsonl'

export function tracePath(dir: string): string {
  return join(dir, TRACE_FILE)
}

/**
 * Append one entry. One file per run directory: the directory is the scope of a run
 * (ADR-0006). Calls that touch no actor — usage and
 * usage errors — land in the run-less file beside the runs. The append takes its own lock so two
 * agents finishing at once cannot interleave lines.
 */
export function appendTrace(dir: string, entry: TraceEntry): Promise<void> {
  mkdirSync(dir, { recursive: true })
  return withLock(dir, 'trace', async () => appendFileSync(tracePath(dir), JSON.stringify(entry) + '\n'))
}

export function readTrace(dir: string): TraceEntry[] {
  const path = tracePath(dir)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as TraceEntry)
}

/**
 * Drop a trace's entries from before `cutoff`, under the same lock as an append, and say how many went. Only for the
 * run-less file: a run's trace is its record, while the run-less one is every actor-less call ever made.
 */
export function trimTrace(dir: string, cutoff: number): Promise<number> {
  return withLock(dir, 'trace', async () => {
    const entries = readTrace(dir)
    const kept = entries.filter((entry) => Date.parse(entry.at) >= cutoff)
    if (kept.length < entries.length) writeFileSync(tracePath(dir), kept.map((entry) => JSON.stringify(entry) + '\n').join(''))
    return entries.length - kept.length
  })
}

/** The self-contained page for a trace: data embedded, no network. `bin` names the run in the page. */
export function renderTrace(entries: TraceEntry[], bin: string): string {
  const data = JSON.stringify({ bin, entries }).replace(/</g, '\\u003c')
  // PAGE is a body fragment (title and style up top) so the same markup serves a hosted page; browsers honour both there.
  // A replacer function, because a string replacement reads `$&`, `$'` and the like in a payload as patterns.
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>\n' +
    PAGE.replace('__TRACE__', () => data) +
    '\n</body></html>\n'
}

/** Render a run directory's trace to `<dir>/trace.html`. Returns what `backseat-ai report` prints. */
export function writeTrace(dir: string, bin: string): { path: string; calls: number } {
  const entries = readTrace(dir)
  const path = join(dir, 'trace.html')
  writeFileSync(path, renderTrace(entries, bin))
  return { path, calls: entries.length }
}
