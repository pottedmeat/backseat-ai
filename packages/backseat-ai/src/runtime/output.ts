import type { Snapshot } from 'xstate'
import { ID_SEPARATOR } from './registry.js'
import type { Store } from './registry.js'

/** The envelope `backseat-ai output` prints. */
export type ActorOutput = { actorId: string; status: 'done'; output: unknown }

/**
 * A finished actor's `output`, read straight from the persisted record.
 *
 * Reading it is a person's or a harness's act, never the agent's — its driver already stated everything it contains
 * — so this is the human bin's and it is a *read*: no run
 * lock, no trace line. The store writes through a rename, so a reader never sees a torn record, and a person reading
 * a run must never land in that run's record as a call the run made.
 */
export async function outputOf(store: Store, actorId: string): Promise<ActorOutput> {
  const [rootId = '', ...path] = actorId.split(ID_SEPARATOR)
  const record = await store.get(rootId)
  if (!record) throw new Error(`Unknown actor '${actorId}'`)
  type Persisted = Snapshot<unknown> & { children?: Record<string, { snapshot?: Persisted }> }
  let snapshot: Persisted | undefined = record.snapshot as Persisted
  for (const segment of path) {
    snapshot = snapshot.children?.[segment]?.snapshot
    if (!snapshot) break
  }
  if (!snapshot) {
    // A collected child is gone from the persisted `children` map on purpose: the gate copied its outcome out before
    // stopping it, and that copy is the only surviving record of what it returned (ADR-0008).
    const key = path[path.length - 1]
    const kept = key === undefined ? undefined : record.collected?.[actorId.slice(0, actorId.length - key.length - 1)]?.[key]
    if (!kept) throw new Error(`Unknown actor '${actorId}'`)
    if (kept.status !== 'done') throw new Error(`Actor '${actorId}' has no output: it was collected after ending ${kept.status}`)
    return { actorId, status: 'done', output: kept.output }
  }
  if (snapshot.status !== 'done') throw new Error(`Actor '${actorId}' has no output: it is ${snapshot.status}`)
  return { actorId, status: 'done', output: snapshot.output }
}
