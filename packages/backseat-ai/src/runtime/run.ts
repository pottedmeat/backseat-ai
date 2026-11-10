import { chmodSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

/** The run a call is acting in: its root actor's id and the directory that is the run (ADR-0006). */
export type CurrentRun = { id: string; dir: string }

let current: CurrentRun | undefined

/**
 * Which run this process is in. Ambient because an implementation is a plain function a definition references: it
 * has no other way to learn the run.
 * Set once per call by the bin, before anything runs; a call is its own process, so nothing outlives it.
 */
export function currentRun(): CurrentRun {
  if (!current) throw new Error('no current run: currentRun() is only meaningful inside a call on an actor')
  return current
}

/** The seam: the bin sets the run once per call; a test sets it to wherever it likes. */
export function setCurrentRun(run: CurrentRun | undefined): void {
  current = run
}

/**
 * A directory only this user can enter, made if missing. A run's files hold full payloads and source, so they are kept
 * private by where they live. One another user already owns is refused: on a shared temp directory they could read
 * everything written under it.
 */
export function privateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.getuid && statSync(dir).uid !== process.getuid()) throw new Error(`${dir} belongs to another user, who could read a run's files there; set TMPDIR and XDG_STATE_HOME to directories of your own`)
  chmodSync(dir, 0o700)
  return dir
}

/**
 * This user's directory under the OS temp dir, `<tmpdir>/backseat-<uid>`. The name is per user because a shared
 * `/tmp/backseat` belongs to whoever made it first. The OS may clean it, so what lives here is what may be lost.
 */
export function userTemp(): string {
  return privateDir(join(tmpdir(), `backseat-${process.getuid?.() ?? userInfo().username}`))
}

/**
 * The run's scratch directory: `<tmpdir>/backseat-<uid>/scratch/<run id>`, a sibling of the run rather than a part of it.
 * What a machine writes for another agent to read is a *courier*, not the record: the prose is already in the record
 * by the time anyone could want it, because a collected child's output is copied there
 * (ADR-0008).
 * So it is destroyed when the run completes, and losing it costs nothing. Derived from the run id alone, which is the
 * root actor's id, so per-run and per-root coincide as they do in
 * ADR-0006.
 */
export function scratchDir(runId: string = currentRun().id): string {
  return join(userTemp(), 'scratch', runId)
}

/**
 * Shed the scratch directory and everything in it. Called when the run completes, beside the pin: both are
 * during-the-run artifacts, while the record and the trace outlive the run.
 */
export function shedScratch(runId: string): void {
  rmSync(scratchDir(runId), { recursive: true, force: true })
}

/**
 * Thrown by an implementation to refuse the event it is running for. The runtime treats it as a rejected event —
 * nothing persists, the actor stays where it was, exit 2 — and hands the agent the message, which should say what
 * to do instead. Any other throw is an error: the actor errors and the run ends.
 */
export class RejectedEvent extends Error {
  override readonly name = 'RejectedEvent'
}

/** By name, not `instanceof`: a machine's code may hold its own copy of this module. */
export function isRejectedEvent(error: unknown): error is RejectedEvent {
  return error instanceof Error && error.name === 'RejectedEvent'
}
