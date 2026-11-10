import { createActor } from 'xstate'
import { scratchDir } from './run.js'
import type { AnyActor, AnyActorRef, AnyMachineSnapshot, AnyStateMachine, InspectionEvent, Snapshot } from 'xstate'

/**
 * Where a child came from, which XState does not record: the state whose spawn site it was filed under and the site's
 * `src`. `src: null` is a child no site declared; `state` is then the source state of the call that saw it appear.
 *
 * A roster name is not a convenience here, it is the only thing a child can be filed under: the only child whose `src`
 * is not a string is one spawned from an inline logic value, and XState refuses to persist that ("An inline child actor
 * cannot be persisted").
 *
 * `about` is the note the parent wrote on this child when it spawned it, resolved at the spawn (see `notes.ts`) or, if
 * the spawn declared none, the input the child was resolved with. It is the parent's, never the child's: nothing on a
 * child-addressed response carries it, and a child asked what it is working on answers from its own `data`.
 */
export type Filed = { state: string; src: string | null; collected?: true; about?: unknown }
/**
 * One settled child as the collection carries it. `status` is how it ended; `stopped` is a child that never finished.
 * `about` rides along because a child that **broke** has no `output` and is already gone: without it, the one case
 * where the parent most needs to know what a child was for is the one case it cannot ask.
 */
export type CollectedChild = { actorId: string; status: 'done' | 'error' | 'stopped'; output?: unknown; error?: string; about?: unknown }
/** What one `settled` entry hands its actions: the site, and every child that settled there. */
export type Collection = { state: string; src: string; children: CollectedChild[] }
/**
 * What the gate copied out of each child before stopping it, by the qualified id of the parent, then the child's own
 * key. `stopChild` deletes a child from the live *and* the persisted `children` map (verified on 5.32.6), so this is
 * the only surviving copy of what a worker returned — read by `backseat-ai output` and by whoever assesses the run, never
 * by the agent (ADR-0008).
 */
export type KeptRecord = Record<string, Record<string, CollectedChild>>
/** Every child the root's tree has seen, by the qualified id of the actor it belongs to, then the child's own key. */
export type SiteRecord = Record<string, Record<string, Filed>>

/**
 * `bin` is the tool that created the root. `project` and `catalog` are where the root's machines came from: the
 * project's name, and the URL of the catalog module that `create` imported. Runs share one directory keyed by root id
 * alone, so the catalog is what stops another project from rehydrating this root with whatever its own catalog files
 * under the same name: a later call from a different one is refused.
 */
export type StoredActor = { machine: string; snapshot: Snapshot<unknown>; sites?: SiteRecord; collected?: KeptRecord; version?: string; scratch?: string; bin?: string; project?: string; catalog?: string }

type MaybePromise<T> = T | Promise<T>

/** Persistence for root actors. Written after every tool action that touches an actor; read when an id is not live. */
export interface Store {
  get(id: string): MaybePromise<StoredActor | undefined>
  put(id: string, record: StoredActor): MaybePromise<void>
}

export function memoryStore(): Store {
  const records = new Map<string, StoredActor>()
  return {
    get: (id) => records.get(id),
    put: (id, record) => {
      records.set(id, record)
    },
  }
}

/** A live actor found by id: the root it belongs to and the ref actually addressed (the root itself, or a spawned descendant). */
export type Resolved = {
  actorId: string
  rootId: string
  root: AnyActor
  ref: AnyActorRef
  machine: AnyStateMachine
}

/** Child ids are qualified by their ancestry: `<rootId>/<childId>[/<grandchildId>...]`. */
export const ID_SEPARATOR = '/'

export class Registry {
  private readonly live = new Map<string, AnyActor>()
  private readonly sites = new Map<string, SiteRecord>()
  private readonly kept = new Map<string, KeptRecord>()
  /** The digest of the pin each root started under, carried across persists so a finished run still says what it ran. */
  private readonly versions = new Map<string, string>()

  constructor(
    private readonly machines: Record<string, AnyStateMachine>,
    private readonly store: Store,
    private readonly createId: () => string,
    /** Watches the root's system, children included, so a call can record the transitions it took. */
    private readonly inspect?: (event: InspectionEvent) => void,
    /** The version of the code this process pinned, recorded once on the root it creates. */
    private readonly version?: string,
    /** The bin this process is, recorded on the root it creates. */
    private readonly bin?: string,
    /** The project whose catalog this process fronts, recorded on the root it creates. */
    private readonly project?: { name: string; catalog: string },
  ) {}

  async create(name: string): Promise<Resolved> {
    const machine = Object.hasOwn(this.machines, name) ? this.machines[name] : undefined
    if (!machine) throw new Error(`Unknown machine '${name}'`)
    const id = this.createId()
    if (id.includes(ID_SEPARATOR)) throw new Error(`Actor ids must not contain '${ID_SEPARATOR}'`)
    const root = observed(createActor(machine, { id, inspect: this.inspect })).start()
    this.live.set(id, root)
    this.sites.set(id, {})
    this.kept.set(id, {})
    if (this.version !== undefined) this.versions.set(id, this.version)
    await this.persist(id)
    return { actorId: id, rootId: id, root, ref: root, machine }
  }

  /** Forget a live root, so the next `resolve` rehydrates it from the store: how a refused event is unwound. */
  discard(rootId: string): void {
    this.live.delete(rootId)
    this.sites.delete(rootId)
    this.kept.delete(rootId)
    this.versions.delete(rootId)
  }

  /** The root's site record, live: written to by whoever files a child, persisted with the snapshot. */
  filed(rootId: string): SiteRecord {
    let record = this.sites.get(rootId)
    if (!record) this.sites.set(rootId, (record = {}))
    return record
  }

  /** The root's preserved collections, live: written by the gate before it stops a child, persisted with the snapshot. */
  collected(rootId: string): KeptRecord {
    let record = this.kept.get(rootId)
    if (!record) this.kept.set(rootId, (record = {}))
    return record
  }

  async resolve(actorId: string): Promise<Resolved> {
    const [rootId = '', ...path] = actorId.split(ID_SEPARATOR)
    const root = await this.root(rootId)
    let ref: AnyActorRef = root
    for (const segment of path) {
      const child = (ref.getSnapshot() as AnyMachineSnapshot).children?.[segment] as AnyActorRef | undefined
      if (!child) {
        // A collected child is gone from its parent on purpose, so say that rather than "unknown": its driver may
        // still be holding the id. The fact, not an instruction — reading an output is never the agent's act,
        // and `backseat-ai` is a bin it does not hold.
        const kept = this.kept.get(rootId)?.[actorId.slice(0, actorId.length - segment.length - 1)]?.[segment]
        if (kept) throw new Error(`Actor '${actorId}' was collected and stopped; it ended ${kept.status}. Its output is kept in the run's record.`)
        throw new Error(`Unknown actor '${actorId}'`)
      }
      ref = child
    }
    const machine = (ref.getSnapshot() as AnyMachineSnapshot).machine as AnyStateMachine | undefined
    if (!machine) throw new Error(`Actor '${actorId}' is not a machine actor`)
    return { actorId, rootId, root, ref, machine }
  }

  async persist(rootId: string): Promise<void> {
    const root = this.live.get(rootId)
    if (!root) return
    const name = Object.keys(this.machines).find((key) => this.machines[key] === root.logic)
    if (!name) throw new Error(`Actor '${rootId}' runs an unregistered machine`)
    // Where this run's scratch is. Derived from the root id rather than carried, unlike `version`, which is a digest
    // of bytes and cannot be recomputed; recorded all the same because `tmpdir()` varies by platform and by
    // environment, and an assessor reading the record should not have to reproduce it.
    const record: StoredActor = { machine: name, snapshot: root.getPersistedSnapshot(), sites: this.filed(rootId), collected: this.collected(rootId), scratch: scratchDir(rootId) }
    const version = this.versions.get(rootId)
    if (version !== undefined) record.version = version
    if (this.bin !== undefined) record.bin = this.bin
    if (this.project !== undefined) Object.assign(record, { project: this.project.name, catalog: this.project.catalog })
    await this.store.put(rootId, record)
  }

  private async root(rootId: string): Promise<AnyActor> {
    const cached = this.live.get(rootId)
    if (cached) return cached
    const record = await this.store.get(rootId)
    if (!record) throw new Error(`Unknown actor '${rootId}'`)
    const machine = this.machines[record.machine]
    if (!machine) throw new Error(`Actor '${rootId}' was created from unknown machine '${record.machine}'`)
    const root = observed(createActor(machine, { id: rootId, snapshot: record.snapshot, inspect: this.inspect })).start()
    this.live.set(rootId, root)
    this.sites.set(rootId, record.sites ?? {})
    this.kept.set(rootId, record.collected ?? {})
    if (record.version !== undefined) this.versions.set(rootId, record.version)
    return root
  }
}

/**
 * An error observer, so a throw inside the machine lands in the snapshot (`status: 'error'`, `error`) instead of
 * XState rethrowing it as an unhandled error and crashing the process. The runtime reads the snapshot and decides.
 */
function observed(actor: AnyActor): AnyActor {
  actor.subscribe({ error: () => {} })
  return actor
}
