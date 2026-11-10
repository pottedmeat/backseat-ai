import { createHash, randomUUID } from 'node:crypto'
import { createActor } from 'xstate'
import type { AnyActorRef, AnyMachineSnapshot, AnyStateMachine, AnyStateNode, AnyTransitionDefinition, InspectionEvent } from 'xstate'
import {
  activeNodes,
  agentTransitions,
  allNodes,
  atomicNodes,
  enabledTransitions,
  isAgentEvent,
  metaOf,
  selectTransitions,
  stripId,
} from './enumerate.js'
import type { EnabledTransition } from './enumerate.js'
import { stepsOf } from './journey.js'
import { clearSpawnNotes, takeSpawnNotes } from './notes.js'
import type { Step } from './journey.js'
import { Registry, memoryStore, ID_SEPARATOR } from './registry.js'
import type { CollectedChild, Collection, Filed, Resolved, SiteRecord, Store } from './registry.js'
import { isRejectedEvent } from './run.js'
import { checkSites, requiresSentence, sitesOf } from './sites.js'
import type { SettledSite } from './sites.js'
import { isSchemaMeta, mergeSchemas, renderSchema, resolveSchema, validatePayload } from './schema.js'
import type { PayloadIssue } from './schema.js'
import { driveProtocol } from './protocol.js'
import type { DriveProtocol } from './protocol.js'
import { AGENT_PRESENTED, CHILD_FAILED, listedKey, resolveInstructions, shownKey } from './tracking.js'
import type { AgentTrackingContext, AgentTrackingEvent } from './tracking.js'

export type Summary = {
  actorId: string
  status: 'active' | 'done' | 'error'
  /** Active atomic states; more than one only in parallel regions. */
  state: Array<{ id: string; description?: string; instructions?: string }>
  /** The value the active state's `meta.data` computes from context, if one declares it. */
  data?: unknown
  /** Status `error` only. */
  error?: string
  targets: Array<{
    id: string
    description: string
    events: Array<{
      type: string
      description?: string
      /** TypeScript type text; present when it differs from what was last shown for this event/target pair on this actor. */
      schema?: string
      /** Set when `schema` is omitted because it is the one last shown for this event/target pair; the move then says to call `describe`. */
      schemaShown?: true
      /**
       * Set when the move is printed by name alone: this actor was shown it whole, with this same text, on an earlier
       * response in the state it is in now (ADR-0016). `schema` is then absent and nothing about it is recorded.
       */
      listed?: true
      /** The fixed sentence for a transition with `settled`: which spawn sites' children must be gone before it may be sent. */
      requires?: string
    }>
  }>
  /** Set when a move is held back because a site it requires settled still has a child running (ADR-0008): one is coming. */
  awaiting?: true
  /** `send` only: the taken transition's own instructions. */
  transition?: { type: string; instructions: string }
  /** How to drive with this tool, on the first response this actor's driver receives. */
  protocol?: DriveProtocol
  /**
   * `create`/`send` only: the children this call spawned, each with what its parent said it was for. Said once, here,
   * and printed as `## Subagents to start`, each with the first command to give it. A parent that wants to know more
   * about a child it already holds the id of asks the child, which answers from its own `data`; nothing about a
   * running child is repeated on later responses.
   */
  children?: Array<{ id: string; about?: unknown }>
}

/**
 * An actor this call moved, the one the call named included: where it came to rest and the transitions it took. It
 * no longer says which version it ran — under a pin every line of a run carries the same one by construction, and it
 * is recorded once on the root's record instead. An actor whose transitions went nowhere is here too — it ran their actions and
 * stayed, which the state it rests in cannot show.
 */
export type Moved = {
  actorId: string
  /** Where it is now. The same as before the call when every step it took went nowhere. */
  state: string[]
  /** The transitions it took, in the order XState fired them, `always` steps included. */
  steps?: Step[]
}

/**
 * `unknown-event` is an event no active state defines at all; `not-enabled` is one the state defines but whose guard
 * hides it right now. The trace tells them apart; the driver is told the same thing of both — the event is not offered
 * from the state it is in — since a move not offered now is never listed (ADR-0008).
 */
export type RejectReason = 'unknown-event' | 'not-enabled' | 'invalid-payload' | 'transition-not-taken' | 'pending-children' | 'refused' | 'action-failed' | 'actor-done' | 'actor-error'

/** One spawn site a `settled` transition still waits on, with the qualified ids of the children pending there. */
export type Pending = SettledSite & { children: string[] }

export type Rejection = Summary & {
  rejected: true
  reason: RejectReason
  issues?: PayloadIssue[]
  schema?: string
  /** `refused`: what the implementation that refused the event said to do instead. `pending-children`: what must settle, then send again. */
  message?: string
  /** `pending-children` only. */
  pending?: Pending[]
}

/**
 * `describe <actorId> <event>`: that one move and nothing else — its destination, its description and its schema. The
 * state's instructions and `data` are not repeated; `describe <actorId>` with no event is the call for those.
 */
export type Description = {
  actorId: string
  status: Summary['status']
  /** Active atomic states, by id alone: where the actor is, for the footer. */
  state: Array<{ id: string }>
  /** How to drive with this tool, on the first response this actor's driver receives. */
  protocol?: DriveProtocol
  event: { type: string; description?: string; schema: string; requires?: string; target: { id: string; description: string } }
}

export type ToolResponse =
  | { machines: Array<{ name: string; description: string }> }
  | Summary
  | Rejection
  | Description

export type RuntimeOptions = {
  machines: Record<string, AnyStateMachine>
  /** Defaults to memory. */
  store?: Store
  /** Root actor ids. Defaults to a UUID; inject for deterministic runs. */
  createId?: () => string
  /**
   * How the tool is invoked. Set it and the runtime delivers the drive protocol on each actor's first presentation;
   * leave it unset and no protocol is delivered, since
   * the paragraph names the command it teaches.
   */
  bin?: string
  /** The project whose catalog this fronts: its name, and the catalog module's URL. Recorded on every root created. */
  project?: { name: string; catalog: string }
  /**
   * The digest of the code this process pinned, recorded once on the record of the root it creates.
   * It outlives the pin, so a completed run still says
   * what it ran after the pin is shed.
   */
  version?: string
}

/**
 * What the harness learns beside a response: the actors the call moved, children no spawn site declared, and — when the
 * taken transition carried an effect that ran — what it returned. `effect` is present whether or not the transition
 * then stood: beside a rejection it records an effect that ran for a transition that was discarded, whose writes stay.
 */
export type Traced<T> = { response: T; moved: Moved[]; warnings: string[]; effect?: { output: unknown } }

export type Runtime = {
  machines(): Array<{ name: string; description: string }>
  create(machine: string): Promise<Summary>
  /** `create`, plus the harness-only channel: a child the initial state spawned that no site declares is a warning. */
  createTraced(machine: string): Promise<Traced<Summary>>
  snapshot(actorId: string): Promise<Summary>
  send(actorId: string, event: { type: string; [key: string]: unknown }): Promise<Summary | Rejection>
  /**
   * `send`, plus the harness-only channel: children no spawn site declares. The response is exactly what `send`
   * returns and is the only thing the agent sees. There is no longer a list of what else moved — under ADR-0008 an
   * actor changes only during a call that names it, so nothing else can have moved.
   */
  sendTraced(actorId: string, event: { type: string; [key: string]: unknown }): Promise<Traced<Summary | Rejection>>
  /**
   * With an event, that one move ({@link Description}). Without one, the current state as an arrival lists it but with
   * the full first-arrival instructions, whatever this actor has already been shown — for a driver that inherits the
   * actor mid-flight, where `snapshot` would hand it the revisit text.
   */
  describe(actorId: string, event?: string): Promise<Description | Summary | Rejection>
}

export function createRuntime(options: RuntimeOptions): Runtime {
  for (const [name, machine] of agentFacingMachines(options.machines)) validateMachine(name, machine)
  /**
   * The transitions a call fired, gathered from XState's inspection stream. `_transitions` on a microstep is the only
   * route to them: the public fields carry the intermediate snapshots but no transition identity, and the guard
   * evaluation that picked between two transitions on one event is not exported, so it cannot be re-run from outside.
   * Its element type is `AnyTransitionDefinition`, the documented return of `getNextTransitions`, and a test drives an
   * `always` chain and asserts they arrive, so an XState upgrade that changed this fails loudly rather than quietly
   * emptying every journey. The peer range can admit an XState that test never ran on, so one without the field is
   * refused here too: an inspector that threw would error the actor and hand its driver a stranger's `TypeError`.
   */
  const collected: Array<{ ref: AnyActorRef; transitions: AnyTransitionDefinition[] }> = []
  /** The actors a call created, so one a later spawn replaced before the call ended is still seen. */
  const created: AnyActorRef[] = []
  let collecting = false
  let unreadable = false
  const inspect = (event: InspectionEvent) => {
    if (collecting && event.type === '@xstate.actor') created.push(event.actorRef as AnyActorRef)
    if (!collecting || event.type !== '@xstate.microstep') return
    if (!Array.isArray(event._transitions)) {
      unreadable = true
      return
    }
    // When two regions of a parallel state both take a transition out on one event, XState keeps only the first and
    // drops the rest after this list was made. A dropped one never entered its target, so the microstep's own snapshot
    // gives it away. One whose target the kept transition entered anyway can't be told apart without XState's private
    // conflict rules, and stays. A history target is never in the snapshot, so it is not checked.
    const entered = new Set(activeNodes(event.snapshot as AnyMachineSnapshot))
    const took = event._transitions.filter((transition) => !transition.target?.length || transition.target.every((target) => target.type === 'history' || entered.has(target)))
    if (!took.length) return
    collected.push({ ref: event.actorRef as AnyActorRef, transitions: took })
  }
  /** Watch only what one send did: rehydrating a root starts it, which steps through everything it already walked. */
  const watch = <T>(act: () => T): T => {
    collected.length = 0
    created.length = 0
    collecting = true
    try {
      const acted = act()
      if (unreadable) throw new Error(`Backseat reads which transitions fired from the _transitions field of XState's inspection events, and the XState installed here no longer carries it. Install xstate@5.33.3, or a backseat-ai that supports this XState. Nothing from this call was saved.`)
      return acted
    } finally {
      collecting = false
    }
  }
  const registry = new Registry(options.machines, options.store ?? memoryStore(), options.createId ?? randomUUID, inspect, options.version, options.bin, options.project)
  const protocol = options.bin === undefined ? undefined : driveProtocol(options.bin)

  /**
   * The drive protocol, if this actor's driver has not been given it. Pushed like any other presentation, so the
   * record is spent by `record` and the next response carries nothing.
   */
  function teach(snap: AnyMachineSnapshot, presented: AgentTrackingEvent[]): DriveProtocol | undefined {
    if (!protocol || (snap.context as { agent?: AgentTrackingContext }).agent?.taught) return undefined
    presented.push({ type: AGENT_PRESENTED, protocol: true })
    return protocol
  }

  const machines = () =>
    Object.entries(options.machines).map(([name, machine]) => ({ name, description: machine.root.description ?? '' }))

  const createTraced = async (name: string): Promise<Traced<Summary>> => {
    clearSpawnNotes()
    const res = await watch(() => registry.create(name))
    const tree = treeView(res)
    const lost = overwritten(new Map(), created, tree)
    if (lost.length && (res.ref.getSnapshot() as AnyMachineSnapshot).status !== 'error') {
      registry.discard(res.rootId)
      throw new Error(`'${name}' could not start: ${lost.join(' ')}`)
    }
    const summary = await present(res)
    const warnings = fileChildren(registry.filed(res.rootId), new Map(), tree)
    // After the filing, not before it: `about` reaches the response off the record that filing writes.
    summary.children = childrenOf(res, {})
    await registry.persist(res.rootId)
    // The actor came into being at its initial state: one entry, so its journey starts on this first call.
    const entry: Moved = { actorId: res.actorId, state: summary.state.map((node) => node.id) }
    const took = stepsByActor(collected, tree).get(res.actorId)
    if (took?.length) entry.steps = took
    return { response: summary, moved: [entry], warnings }
  }

  const create = async (name: string): Promise<Summary> => (await createTraced(name)).response

  const snapshot = async (actorId: string): Promise<Summary> => {
    const res = await registry.resolve(actorId)
    const summary = await present(res)
    await registry.persist(res.rootId)
    return summary
  }

  const sendTraced = async (actorId: string, event: { type: string; [key: string]: unknown }): Promise<Traced<Summary | Rejection>> => {
    let res = await registry.resolve(actorId)
    const reject = async (reason: RejectReason, extra: Partial<Rejection> = {}): Promise<Traced<Rejection>> => {
      const summary = await present(res)
      await registry.persist(res.rootId)
      return { response: { ...summary, rejected: true, reason, ...extra }, moved: [], warnings: [] }
    }

    const before = res.ref.getSnapshot() as AnyMachineSnapshot
    if (before.status !== 'active') return reject(before.status === 'done' ? 'actor-done' : 'actor-error')

    const { type, ...payload } = event
    const enabled = enabledTransitions(before).find((e) => e.type === type)
    if (!enabled) return reject(definedHere(before, type) ? 'not-enabled' : 'unknown-event')

    const settled = metaOf(enabled.transition)?.settled
    // Before the payload is even looked at: what must settle is the whole answer, and the actor does not move.
    const pending = pendingOf(registry.filed(res.rootId)[actorId], before, actorId, settled)
    if (pending.length) return reject('pending-children', { pending, message: `${stillRunning(pending)} Send ${type} again once they have.` })

    const schema = contractOf(enabled, before.context)
    const validated = validatePayload(schema, payload)
    if (!validated.ok) return reject('invalid-payload', { issues: validated.issues, schema: renderSchema(schema) })

    const full: { type: string; [key: string]: unknown } = { type, ...validated.data }
    if (selectTransitions(before, full).length === 0) return reject('transition-not-taken')

    // The effect: after every check has passed and the transition is chosen — guards never see what it returns — and
    // before anything durable changes, so a refusal here leaves nothing to unwind. It runs inside the call that names
    // the actor, which is what keeps ADR-0008 intact where an `invoke` would not.
    const effect = metaOf(enabled.transition)?.effect
    let ran: { output: unknown } | undefined
    if (effect) {
      try {
        ran = { output: await effect({ context: before.context, event: full }) }
      } catch (error) {
        if (isRejectedEvent(error)) return reject('refused', { message: error.message })
        return reject('action-failed', { message: error instanceof Error ? error.message : String(error) })
      }
      // The first wait between the checks above and the send below. The CLI holds the root's lock across the whole
      // call; a caller of this runtime that does not, and lets a second call in meanwhile, would have this event land
      // on an actor none of those checks looked at. That is a bug in the caller, and it is said here rather than sent.
      if (res.ref.getSnapshot() !== before) throw new Error(`'${actorId}' changed while the effect of '${type}' ran; calls on one root must not overlap`)
      // Injected after validation, as `settled` is: an agent cannot supply `output`, and the one it would see is this.
      full.output = ran.output
    }
    const withEffect = (traced: Traced<Rejection>): Traced<Rejection> => (ran ? { ...traced, effect: ran } : traced)

    const childrenBefore = before.children ?? {}
    const treeBefore = treeView(res)
    clearSpawnNotes()
    // The collection. Taken *after* the guards have chosen the transition — a guard may not read the payload at all,
    // so nothing here can steer which one is taken — and *before* the send, because the stop action the compiler
    // appended to this transition deletes each collected child from the live and the persisted children map alike.
    const collection = settled?.length ? collectOf(registry.filed(res.rootId)[actorId], before, actorId, settled) : []
    if (collection.length) {
      const kept = (registry.collected(res.rootId)[actorId] ??= {})
      const filed = registry.filed(res.rootId)[actorId]
      for (const site of collection) {
        for (const child of site.children) {
          const key = child.actorId.slice(child.actorId.lastIndexOf(ID_SEPARATOR) + 1)
          kept[key] = child
          // Collected, never cleared: two transitions waiting on one site both see it, and it is the next spawn there
          // after a collection that drops these (ADR-0008).
          const entry = filed?.[key]
          if (entry) entry.collected = true
        }
      }
    }
    // The agent's own event, augmented with what settled: a first, and the reason validation ran before this line.
    const sent = collection.length ? { ...full, settled: collection } : full
    watch(() => res.ref.send(sent))
    const after = res.ref.getSnapshot() as AnyMachineSnapshot
    const refusal = after.status === 'error' && isRejectedEvent(after.error) ? after.error : undefined
    if (refusal) {
      // An implementation refused the event: unwind to the persisted record, which the send never touched, and
      // answer from there. The errored actor is dropped with the process.
      registry.discard(res.rootId)
      res = await registry.resolve(actorId)
      return withEffect(await reject('refused', { message: refusal.message }))
    }
    if (after.status === 'error' && collection.length) {
      // An action threw on a *collecting* transition, and XState discards a whole transition when any action throws:
      // every `assign` it ran, and `stopCollected`, which lowering appends last. This is the one transition that has
      // already changed durable state before the send — the lines above copied each child's outcome into the run
      // record and flagged the site collected — so persisting the errored snapshot would strand those children:
      // recorded as collected, never stopped, live under a dead root, their outputs in a record the machine can no
      // longer reach. Unwind instead, which puts the site back exactly as it was. The children are pending again,
      // uncollected and unstopped, and the next attempt collects them; a collection is repeatable by design
      // (ADR-0008), so nothing is lost.
      //
      // A throw on any other transition still errors the actor, which is how a worker breaks: nothing was collected
      // there, so nothing is orphaned, and `status: 'error'` in a collection would be unreachable without it.
      registry.discard(res.rootId)
      res = await registry.resolve(actorId)
      return withEffect(await reject('action-failed', { message: after.error instanceof Error ? after.error.message : String(after.error) }))
    }
    const treeAfter = treeView(res)
    // Not on an errored actor: XState drops the whole microstep, so a child spawned before the throw was never started.
    const lost = after.status === 'error' ? [] : overwritten(treeBefore, created, treeAfter, new Set(collection.flatMap((site) => site.children.map((child) => child.actorId))))
    if (lost.length) {
      // A spawn filed its child under a key that already held one. XState replaces the entry without stopping what was
      // there, so that child runs on, held by nothing: never collected, its output lost. Unwind, as for a throw.
      registry.discard(res.rootId)
      res = await registry.resolve(actorId)
      return withEffect(await reject('action-failed', { message: lost.join(' ') }))
    }
    const moved = movedBy(treeBefore, treeAfter, actorId, stepsByActor(collected, treeAfter))
    // The addressed actor's transition is known exactly: its source and the states it entered are where a child is
    // looked for. No other actor in the tree can have moved during this call — an `on` key no agent can send is
    // refused outright — so the before-and-after view below is reached from `create` alone, where there is no
    // addressed transition to read.
    const warnings = fileChildren(registry.filed(res.rootId), treeBefore, treeAfter, {
      actorId,
      candidates: [enabled.transition.source, ...enteredNodes(before, after, enabled.transition)],
      fallback: stripId(res.machine, enabled.transition.source.id),
    })

    // The one response `data` is handed the event: what it shows from it is said here and never again.
    const summary = await present(res, sent)
    const instructions = resolveInstructions(metaOf(enabled.transition)?.instructions, before.context, 'first', `'${type}' from '${stripId(res.machine, enabled.transition.source.id)}'`)
    if (instructions) summary.transition = { type, instructions }
    summary.children = childrenOf(res, childrenBefore)
    await registry.persist(res.rootId)
    return ran ? { response: summary, moved, warnings, effect: ran } : { response: summary, moved, warnings }
  }

  const send = async (actorId: string, event: { type: string; [key: string]: unknown }): Promise<Summary | Rejection> =>
    (await sendTraced(actorId, event)).response

  const describe = async (actorId: string, eventType?: string): Promise<Description | Summary | Rejection> => {
    const res = await registry.resolve(actorId)
    const snap = res.ref.getSnapshot() as AnyMachineSnapshot
    if (eventType === undefined) {
      const summary = await present(res, undefined, { full: true })
      await registry.persist(res.rootId)
      return summary
    }
    if (snap.status !== 'active') {
      const summary = await present(res)
      await registry.persist(res.rootId)
      return { ...summary, rejected: true, reason: snap.status === 'done' ? 'actor-done' : 'actor-error' }
    }
    const enabled = enabledTransitions(snap).find((e) => e.type === eventType)
    if (!enabled) {
      const summary = await present(res)
      await registry.persist(res.rootId)
      return { ...summary, rejected: true, reason: definedHere(snap, eventType) ? 'not-enabled' : 'unknown-event' }
    }
    const settled = metaOf(enabled.transition)?.settled
    // Not listed while its children run (ADR-0008), so not described either: the refusal says what must settle.
    const pending = pendingOf(registry.filed(res.rootId)[actorId], snap, actorId, settled)
    if (pending.length) {
      const summary = await present(res)
      await registry.persist(res.rootId)
      return { ...summary, rejected: true, reason: 'pending-children', pending, message: `${stillRunning(pending)} ${eventType} is offered once they have.` }
    }
    const targetId = stripId(res.machine, enabled.target.id)
    const presented: AgentTrackingEvent[] = []
    const description: Description = {
      actorId,
      status: statusOf(snap),
      state: atomicNodes(snap).map((node) => ({ id: stripId(res.machine, node.id) })),
      event: {
        type: eventType,
        description: enabled.transition.description,
        schema: renderSchema(contractOf(enabled, snap.context)),
        ...(settled?.length ? { requires: requiresSentence(settled) } : {}),
        target: { id: targetId, description: enabled.target.description ?? '' },
      },
    }
    presented.push({ type: AGENT_PRESENTED, eventType, targetId: shownUnder(res, enabled), schema: description.event.schema })
    const taught = teach(snap, presented)
    if (taught) description.protocol = taught
    record(res, presented)
    await registry.persist(res.rootId)
    return description
  }

  return { machines, create, createTraced, snapshot, send, sendTraced, describe }

  /**
   * Build the Summary for the actor's current state and record what it presented (visits and shown schemas). `event` is
   * the event a successful send delivered, for `data`; every other response passes none. `full` reads the first-arrival
   * instructions whatever has been seen, for `describe` without an event.
   */
  async function present(res: Resolved, event?: DataEvent, opts: { full?: boolean } = {}): Promise<Summary> {
    const snap = res.ref.getSnapshot() as AnyMachineSnapshot
    const presented: AgentTrackingEvent[] = []
    const summary: Summary = {
      actorId: res.actorId,
      status: statusOf(snap),
      state: stateEntries(res, snap, { full: opts.full ?? false, presented }),
      targets: [],
    }
    const data = dataOf(snap, event)
    if (data !== undefined) summary.data = data
    if (snap.status === 'error') summary.error = snap.error instanceof Error ? snap.error.message : String(snap.error)
    if (snap.status === 'active') {
      const filed = registry.filed(res.rootId)[res.actorId]
      const waiting = (enabled: EnabledTransition) => pendingOf(filed, snap, res.actorId, metaOf(enabled.transition)?.settled).length > 0
      summary.targets = targetsOf(res, snap, presented, waiting, opts.full ?? false)
      if (enabledTransitions(snap).some(waiting)) summary.awaiting = true
    }
    const taught = teach(snap, presented)
    if (taught) summary.protocol = taught
    record(res, presented)
    return summary
  }

  function record(res: Resolved, presented: AgentTrackingEvent[]) {
    const snap = res.ref.getSnapshot() as AnyMachineSnapshot
    if (snap.status !== 'active') return
    for (const event of presented) res.ref.send(event)
  }

  /** Runs after `fileChildren`, which is what puts `about` on the record this reads. */
  function childrenOf(res: Resolved, before: AnyMachineSnapshot['children']): Summary['children'] {
    const snap = res.ref.getSnapshot() as AnyMachineSnapshot
    const filed = registry.filed(res.rootId)[res.actorId]
    return Object.keys(snap.children ?? {})
      .filter((id) => snap.children[id] !== before[id])
      .map((id) => {
        const entry: NonNullable<Summary['children']>[number] = { id: `${res.actorId}${ID_SEPARATOR}${id}` }
        const about = filed?.[id]?.about
        if (about !== undefined) entry.about = about
        return entry
      })
  }
}

/** One machine actor in the root as a call found it: its active atomic state ids as the Summary reports them, its active nodes, its children. */
type ActorView = { ref: AnyActorRef; machine: AnyStateMachine; snapshot: AnyMachineSnapshot; state: string[]; active: AnyStateNode[]; children: string[] }

/** Every machine actor in the root, by qualified id. */
function treeView(res: Resolved): Map<string, ActorView> {
  const views = new Map<string, ActorView>()
  const visit = (ref: AnyActorRef, id: string) => {
    const snap = ref.getSnapshot() as AnyMachineSnapshot
    const machine = snap.machine as AnyStateMachine | undefined
    if (!machine) return
    views.set(id, { ref, machine, snapshot: snap, state: atomicNodes(snap).map((node) => stripId(machine, node.id)), active: activeNodes(snap), children: Object.keys(snap.children ?? {}) })
    for (const [key, child] of Object.entries(snap.children ?? {})) visit(child as AnyActorRef, `${id}${ID_SEPARATOR}${key}`)
  }
  visit(res.root, res.rootId)
  return views
}

/**
 * A sentence for each child a spawn replaced. XState files a child under its id and overwrites whatever that key held
 * without stopping it, so the child goes on running with no parent holding it. Whether it was there before the call or
 * spawned during it, its key now holds another child. One stopped first is not replaced but succeeded: a running child
 * says so by its status, and a finished one, whose status stopping leaves alone, by being among the `collected`.
 */
function overwritten(before: Map<string, ActorView>, created: AnyActorRef[], after: Map<string, ActorView>, collected: Set<string> = new Set()): string[] {
  const replaced = (ref: AnyActorRef) => {
    const held = (ref._parent?.getSnapshot() as AnyMachineSnapshot | undefined)?.children?.[ref.id]
    return held !== undefined && held !== ref && (ref.getSnapshot() as { status: string }).status !== 'stopped'
  }
  const sentences = new Set<string>()
  for (const [id, view] of before) if (!collected.has(id) && replaced(view.ref)) sentences.add(`A spawn replaced the child '${id}' before it was collected.`)
  for (const ref of created) {
    if (!replaced(ref)) continue
    const parent = [...after].find(([, view]) => view.ref === ref._parent)?.[0]
    sentences.add(`Two children were spawned as '${parent === undefined ? ref.id : `${parent}${ID_SEPARATOR}${ref.id}`}' and only the second was kept.`)
  }
  if (sentences.size) sentences.add('Each child a machine holds at once needs its own id.')
  return [...sentences]
}

/**
 * The steps each actor took, by qualified id. Inspection is system-wide, so one observer on the root sees every actor
 * in the tree; a microstep's `actorRef` is matched by identity against the tree as the call left it. An actor that was
 * gone by then is dropped: there is no machine left to name its transitions against.
 */
function stepsByActor(collected: Array<{ ref: AnyActorRef; transitions: AnyTransitionDefinition[] }>, after: Map<string, ActorView>): Map<string, Step[]> {
  const named = new Map<AnyActorRef, { id: string; view: ActorView }>()
  for (const [id, view] of after) named.set(view.ref, { id, view })
  const steps = new Map<string, Step[]>()
  for (const { ref, transitions } of collected) {
    const found = named.get(ref)
    if (!found) continue
    const took = stepsOf(transitions, found.view.machine)
    const already = steps.get(found.id)
    if (already) already.push(...took)
    else steps.set(found.id, took)
  }
  return steps
}

/**
 * The actor the call moved: the one it named, and no other. It is here when it took a step or when its state changed —
 * a transition that acts and stays is a move the landing state cannot show.
 *
 * One call moves one actor by construction: the `on` keys that could carry a parent along behind its own agent are
 * refused. A child that appeared during the call is its parent's spawn, listed once it steps for itself.
 */
function movedBy(before: Map<string, ActorView>, after: Map<string, ActorView>, addressed: string, steps: Map<string, Step[]>): Moved[] {
  const view = after.get(addressed)
  if (!view) return []
  const was = before.get(addressed)?.state
  const took = steps.get(addressed)
  if (!took?.length && (!was || was.join(' ') === view.state.join(' '))) return []
  const entry: Moved = { actorId: addressed, state: view.state }
  if (took?.length) entry.steps = took
  return [entry]
}

/** The states a transition entered: newly active nodes, the targets themselves (re-entered on a self-transition) and what is active under them. */
function enteredNodes(before: AnyMachineSnapshot, after: AnyMachineSnapshot, transition: AnyTransitionDefinition): AnyStateNode[] {
  const wasActive = new Set(activeNodes(before))
  const targets = transition.target ?? []
  const under = (node: AnyStateNode) => targets.some((t) => node === t || node.path.join('.').startsWith(t.path.join('.') + '.'))
  const entered = new Set<AnyStateNode>([...targets, ...activeNodes(after).filter((node) => !wasActive.has(node) || under(node))])
  return [...entered].sort((a, b) => a.order - b.order)
}

/**
 * File every child that appeared in the tree during a call under a spawn site, in the root's site record
 * (ADR-0008): the site whose
 * `src` matches the child's, looked for among the candidate states. A child no site accounts for is filed with
 * `src: null` and returned as a warning; the call is never failed for it.
 */
function fileChildren(record: SiteRecord, before: Map<string, ActorView>, after: Map<string, ActorView>, addressed?: { actorId: string; candidates: AnyStateNode[]; fallback: string }): string[] {
  const warnings: string[] = []
  // The notes this call's spawns left behind, drained once. Taking them per actor and `src`, in order, is what pairs
  // each note with its own child: the note action ran between one spawn and the next, so the order is the spawn order.
  const notes = takeSpawnNotes()
  for (const [actorId, view] of after) {
    const was = before.get(actorId)
    // By the child held, not the key: a key a collected child held is free for the next spawn to reuse.
    const appeared = view.children.filter((key) => was?.snapshot.children?.[key] !== view.snapshot.children?.[key])
    if (!appeared.length) continue
    let candidates: AnyStateNode[]
    let fallback: string
    if (addressed && actorId === addressed.actorId) ({ candidates, fallback } = addressed)
    else {
      candidates = [...new Set([...(was?.active ?? []), ...view.active])]
      fallback = (was ?? view).state[0] ?? stripId(view.machine, view.machine.root.id)
    }
    const filed = (record[actorId] ??= {})
    for (const key of appeared) {
      const child = view.snapshot.children?.[key] as { src?: unknown; options?: { input?: unknown } } | undefined
      const src = typeof child?.src === 'string' ? child.src : undefined
      // What the parent said this child is for. A declared `about` was resolved at the spawn and is waiting in the
      // notes; absent one, the input the child was actually resolved with stands in — which is free here and works for
      // plain XState `spawnChild` too, the value being read off the child rather than off the call. It has to be taken
      // now either way: `options.input` does not survive rehydration, and the notes do not outlive this call.
      const noted = src === undefined ? -1 : notes.findIndex((n) => n.ref === view.ref && n.src === src)
      const about = noted >= 0 ? notes.splice(noted, 1)[0]?.about : child?.options?.input
      const node = src === undefined ? undefined : candidates.find((n) => sitesOf(n).some((s) => s.src === src))
      if (node && src !== undefined) {
        const state = stripId(view.machine, node.id)
        // ADR-0008: the next spawn at a site after a collection is what clears that collection, which is what keeps
        // one round's workers out of the next round's. Being collected never clears it; spawning again does.
        for (const [old, entry] of Object.entries(filed)) if (entry.collected && entry.state === state && entry.src === src) delete filed[old]
        filed[key] = about === undefined ? { state, src } : { state, src, about }
      }
      else {
        // Nothing declared the site — a `spawnChild` inside an action's body is invisible to the lowering that reads
        // sites off the action list — but the child knows what it is, and the call knows where it started. Those two
        // facts are the site, so file it and let it be collected; only a child with no `src` at all cannot be.
        //
        // A child with no `src` at all is the exception, and it never reaches a record: the only way to produce one is
        // to spawn an inline logic value, which XState will not persist, so this call fails a few lines later at
        // `persist`. The warning is still worth raising, because it names the cause before that error does.
        filed[key] = about === undefined ? { state: fallback, src: src ?? null } : { state: fallback, src: src ?? null, about }
        if (src === undefined) warnings.push(`child ${actorId}${ID_SEPARATOR}${key} spawned by ${actorId} has no src and cannot be collected (state ${fallback})`)
      }
    }
  }
  return warnings
}

/**
 * Every child settled at each site the transition requires settled, with how it ended. `pendingOf` has already passed,
 * so none of them is still running. This is the only chance to keep what a worker returned: the stop action appended
 * to this transition erases each child from the live *and* the persisted `children` map (verified on 5.32.6).
 */
function collectOf(filed: Record<string, Filed> | undefined, snap: AnyMachineSnapshot, actorId: string, settled: SettledSite[]): Collection[] {
  return settled.map((site) => {
    const children: CollectedChild[] = []
    for (const [key, ref] of Object.entries(snap.children ?? {})) {
      if (filed?.[key]?.state !== site.state || filed?.[key]?.src !== site.src) continue
      const child = (ref as AnyActorRef).getSnapshot() as AnyMachineSnapshot
      const entry: CollectedChild = { actorId: `${actorId}${ID_SEPARATOR}${key}`, status: child.status === 'done' ? 'done' : child.status === 'error' ? 'error' : 'stopped' }
      const about = filed?.[key]?.about
      if (about !== undefined) entry.about = about
      if (child.status === 'done') entry.output = child.output
      if (child.status === 'error') entry.error = child.error instanceof Error ? child.error.message : String(child.error)
      children.push(entry)
    }
    return { state: site.state, src: site.src, children }
  })
}

/**
 * The refusal's first sentence, in the agent's frame: the subagents not yet finished, by id, in one list across every
 * site still waited on. The site and the machine name
 * stay on the structured `pending` for the trace; the agent knows neither as a thing, and the ids are the whole answer.
 */
const stillRunning = (pending: Pending[]) => `these subagents have not finished their workflows: ${pending.flatMap((p) => p.children).join(', ')}.`

/**
 * The sites a transition requires settled that still have a pending child, with those children's qualified ids. XState
 * keeps a finished child among its parent's children until something stops it, so "gone from the parent" reads as
 * "not still active": finished, failed or stopped alike is settled, as the spec says.
 */

function pendingOf(filed: Record<string, Filed> | undefined, snap: AnyMachineSnapshot, actorId: string, settled: SettledSite[] | undefined): Pending[] {
  if (!settled?.length || !filed) return []
  const present = Object.entries(snap.children ?? {})
    .filter(([, child]) => ((child as AnyActorRef).getSnapshot() as { status?: string }).status === 'active')
    .map(([key]) => key)
  const out: Pending[] = []
  for (const site of settled) {
    const children = present.filter((key) => filed[key]?.state === site.state && filed[key]?.src === site.src).map((key) => `${actorId}${ID_SEPARATOR}${key}`)
    if (children.length) out.push({ state: site.state, src: site.src, children })
  }
  return out
}

/** Whether some active state defines an agent-facing transition for `type` — enabled or not. */
function definedHere(snapshot: AnyMachineSnapshot, type: string): boolean {
  return activeNodes(snapshot).some((node) => agentTransitions(node).some((t) => t.eventType === type))
}

/**
 * A state's schema is the payload to enter it, so a targetless transition carries only its own schema.
 * Either side may be a function of context, resolved here against the actor's current context.
 */
function contractOf(enabled: EnabledTransition, context: unknown) {
  const target = enabled.transition.target ? resolveSchema(metaOf(enabled.target)?.schema, context, `'${enabled.target.id}'`) : undefined
  const transition = resolveSchema(metaOf(enabled.transition)?.schema, context, `'${enabled.type}' from '${enabled.transition.source.id}'`)
  return mergeSchemas(target, transition)
}

function statusOf(snap: AnyMachineSnapshot): Summary['status'] {
  return snap.status === 'active' ? 'active' : snap.status === 'done' ? 'done' : 'error'
}

function stateEntries(
  res: Resolved,
  snap: AnyMachineSnapshot,
  opts: { full: boolean; presented: AgentTrackingEvent[] },
): Summary['state'] {
  const visited = (snap.context as { agent?: AgentTrackingContext }).agent?.visited ?? []
  const active = activeNodes(snap)
  return atomicNodes(snap).map((node) => {
    const lineage = active.filter((n) => node === n || node.path.join('.').startsWith(n.path.join('.') + '.') || n.parent === undefined)
    const texts: string[] = []
    for (const n of lineage) {
      const id = stripId(res.machine, n.id)
      const seen = visited.includes(id)
      // `describe` without an event asks for the full account whatever the actor has seen, so it reads the first-arrival prose.
      const text = resolveInstructions(metaOf(n)?.instructions, snap.context, opts.full || !seen ? 'first' : 'revisit', `'${n.id}'`)
      if (text === undefined) continue
      texts.push(text)
      if (!seen && !opts.presented.some((p) => 'targetId' in p && p.eventType === undefined && p.targetId === id)) {
        opts.presented.push({ type: AGENT_PRESENTED, targetId: id })
      }
    }
    const entry: Summary['state'][number] = { id: stripId(res.machine, node.id) }
    // Dropped on arrival, including the first: a description says *why an agent would go there*, which is spent once
    // it is there, and the agent chose this state from a `targets[]` entry that already carried it. The instructions
    // carry the meaning instead. `describe` once kept it, beside
    // the instructions it repeated; it now prints one move alone (ADR-0015), whose destination's description it carries.
    if (texts.length) entry.instructions = texts.join('\n\n')
    return entry
  })
}

type DataEvent = { type: string; [key: string]: unknown }

/** The active state's `meta.data` applied to context. Registration guarantees at most one active state declares it. */
function dataOf(snap: AnyMachineSnapshot, event?: DataEvent): unknown {
  for (const node of activeNodes(snap)) {
    const data = metaOf(node)?.data
    if (data) return data({ context: snap.context, event })
  }
  return undefined
}

/**
 * The moves offered now, and only those (ADR-0008): a guard that fails already keeps a transition out of
 * `enabledTransitions`, and `waiting` drops one whose `settled` sites still have children running — it would be refused
 * as `pending-children`, so it is not offered yet.
 *
 * A move this actor was shown whole in the state it is in now, and whose text has not changed since, is `listed` and
 * printed by name alone (ADR-0016): the full list cost every response in a state ~4K tokens to say again what the first
 * one said. `full` — `describe` without an event — prints every move whole.
 */
function targetsOf(res: Resolved, snap: AnyMachineSnapshot, presented: AgentTrackingEvent[], waiting: (enabled: EnabledTransition) => boolean, full: boolean): Summary['targets'] {
  const agent = (snap.context as { agent?: AgentTrackingContext }).agent
  const shown = agent?.shown ?? {}
  const listed = agent?.listed ?? {}
  const state = atomicNodes(snap).map((node) => stripId(res.machine, node.id)).join(', ')
  const printed: Record<string, string> = {}
  const groups = new Map<string, Summary['targets'][number]>()
  for (const enabled of enabledTransitions(snap)) {
    if (waiting(enabled)) continue
    const targetId = stripId(res.machine, enabled.target.id)
    let group = groups.get(targetId)
    if (!group) {
      group = { id: targetId, description: enabled.target.description ?? '', events: [] }
      groups.set(targetId, group)
    }
    const entry: Summary['targets'][number]['events'][number] = { type: enabled.type }
    if (enabled.transition.description) entry.description = enabled.transition.description
    const settled = metaOf(enabled.transition)?.settled
    if (settled?.length) entry.requires = requiresSentence(settled)
    // Rendered every call so a schema that is a function of context re-shows the moment its text changes.
    const schema = renderSchema(contractOf(enabled, snap.context))
    const key = listedKey(state, enabled.type, targetId)
    const digest = createHash('sha256').update(JSON.stringify([group.description, entry.description, entry.requires, schema])).digest('base64url').slice(0, 16)
    if (!full && listed[key] === digest) {
      entry.listed = true
      group.events.push(entry)
      continue
    }
    printed[key] = digest
    if (shown[shownKey(enabled.type, shownUnder(res, enabled))] !== schema) {
      entry.schema = schema
      presented.push({ type: AGENT_PRESENTED, eventType: enabled.type, targetId: shownUnder(res, enabled), schema })
    } else {
      entry.schemaShown = true
    }
    group.events.push(entry)
  }
  if (Object.keys(printed).length) presented.push({ type: AGENT_PRESENTED, listed: printed })
  return [...groups.values()]
}

/**
 * The node a move's shown schema is recorded against (ADR-0016): its destination, or, for a move with none, the node
 * that declares it. A targetless move declared on the root is listed under whichever atomic state the actor is in, and
 * keyed by that it was re-sent, unchanged, on the first arrival at every state.
 */
function shownUnder(res: Resolved, enabled: EnabledTransition): string {
  return stripId(res.machine, (enabled.transition.target?.[0] ?? enabled.transition.source).id)
}

/**
 * Every machine an agent can be handed: the registered roots, and the machines they spawn, found through
 * `setup({ actors })`. Being named in `options.machines` is how the runtime was configured, not a safety property — a
 * spawn-only machine is driven through the identical tool surface, and `researchTask`, which holds three of the seven
 * `data` projections, had never been through a single registration check. Names a machine by the path it was found on, so a
 * failure says how it was reached, and dedupes by identity, which also terminates on a machine that spawns itself.
 */
function agentFacingMachines(roots: Record<string, AnyStateMachine>): Array<[string, AnyStateMachine]> {
  const found: Array<[string, AnyStateMachine]> = []
  const seen = new Set<AnyStateMachine>()
  const walk = (name: string, machine: AnyStateMachine) => {
    if (seen.has(machine)) return
    seen.add(machine)
    found.push([name, machine])
    const actors = (machine.implementations as { actors?: Record<string, unknown> }).actors ?? {}
    // Machines only: a promise, callback or observable actor has no `root` and nothing registration checks.
    for (const [key, logic] of Object.entries(actors)) {
      if (typeof logic === 'object' && logic !== null && 'root' in logic) walk(`${name} > ${key}`, logic as AnyStateMachine)
    }
  }
  for (const [name, machine] of Object.entries(roots)) walk(name, machine)
  return found
}

/** Registration-time checks. Throws on the first violation so a bad machine never reaches an agent. */
export function validateMachine(name: string, machine: AnyStateMachine): void {
  const fail = (message: string): never => {
    throw new Error(`Machine '${name}': ${message}`)
  }
  const cause = (error: unknown) => (error instanceof Error ? error.message : String(error))
  if (!machine.root.description) fail('the root node needs a description; it is the catalog entry')
  if (!machine.root.transitions.has(AGENT_PRESENTED)) fail(`the root needs the tracking hook: spread agentTracking.on into its 'on'`)

  let initial: AnyMachineSnapshot
  const sampleInput = metaOf(machine.root)?.sampleInput ?? {}
  try {
    initial = createActor(machine, { input: sampleInput }).getSnapshot() as AnyMachineSnapshot
  } catch (error) {
    return fail(`could not compute the initial snapshot: ${cause(error)}`)
  }
  // XState absorbs a throwing context initializer into an error snapshot instead of rethrowing, so the `catch` above
  // never sees it. Left unread, the empty context that follows failed the tracking-slice check below and named the one
  // thing that was demonstrably present; read the status and the real cause is reported instead.
  if (initial.status === 'error') return fail(`could not compute the initial snapshot: ${cause(initial.error)}`)
  const agent = (initial.context as { agent?: Partial<AgentTrackingContext> } | undefined)?.agent
  if (typeof agent?.shown !== 'object' || agent.shown === null || Array.isArray(agent.shown) || !Array.isArray(agent?.visited) || typeof agent?.taught !== 'boolean') {
    fail(`context needs the tracking slice: spread agentTracking.context into the machine context`)
  }

  const targeted = new Set<AnyStateNode>()
  const nodes = allNodes(machine)
  for (const node of nodes) {
    for (const [descriptor, transitions] of node.transitions) checkDescriptor(fail, node, node === machine.root, descriptor, transitions)
    // An effect runs inside the call that sends its event, so it belongs on an event an agent sends and nowhere else:
    // on any other key it would run with no call to name the actor, which is what ADR-0008 forbids.
    for (const [descriptor, transitions] of node.transitions) {
      if (!isAgentEvent(descriptor) && transitions.some((t) => metaOf(t)?.effect)) fail(`an effect on '${descriptor}' from '${node.id}' would run with no agent's call to run in; an effect belongs on an event an agent sends`)
    }
    if (node.always?.some((t) => metaOf(t)?.effect)) fail(`an effect on 'always' from '${node.id}' would run with no agent's call to run in; an effect belongs on an event an agent sends`)
    const meta = metaOf(node)
    if (meta?.schema !== undefined && !isSchemaMeta(meta.schema)) fail(`meta.schema on '${node.id}' must be a zod object schema or a function of context returning one`)
    if (declaresOutput(meta?.schema)) fail(`meta.schema on '${node.id}' declares 'output', which is reserved: it is what a transition's effect returned`)
    for (const t of agentTransitions(node)) {
      checkTransition(fail, node, t)
      const target = t.target?.[0] ?? node
      targeted.add(target)
      if (!target.description && target.parent !== undefined) {
        fail(`'${target.id}' is reached by '${t.eventType}' and needs a description`)
      }
    }
  }
  for (const node of nodes) {
    if (metaOf(node)?.schema && !targeted.has(node)) {
      fail(`meta.schema on '${node.id}' can never be presented: no agent-facing transition targets it`)
    }
  }

  // `Summary.data` is one value, so two states that can be active together must not both declare it.
  const declaring = nodes.filter((node) => metaOf(node)?.data !== undefined)
  for (const [i, a] of declaring.entries()) {
    const b = declaring.slice(i + 1).find((other) => coActive(a, other))
    if (b) fail(`meta.data on '${a.id}' and '${b.id}' can be active together; declare it on one of them`)
  }

  checkInstructionData(name, machine, initial.context)
  // A child is filed by the transition, so one that could reach two sites of one src is refused here too, for a machine no compiler checked.
  const sites = checkSites(machine)
  if (sites.errors.length) fail(sites.errors[0]!)
}

/**
 * The `data.<key>` names an instruction block reads out of `Summary.data`. Only the marked form is a name a check can
 * resolve: prose also backticks event fields (`sourceUrl`), so a bare identifier is not evidence of a `data` key.
 */
export function dataNames(text: string): string[] {
  return [...text.matchAll(/`data\.([A-Za-z_$][\w$]*)`/g)].map((m) => m[1]!)
}

/**
 * Every `data.<key>` an instruction names is emitted by the projection that will be live where the prose is read.
 * Instructions are the agent's only account of what it was handed, and a key the projection stopped emitting reads as
 * `undefined` against a well-formed call — the failure this repo has learned to distrust.
 *
 * Run by `validateMachine`, against the initial snapshot's context. It needs no *live* context: every projection is
 * an object literal whose key set is fixed even where each value is still empty. It was a per-machine test until
 * registration could reach a spawn-only machine, where three of the seven projections live.
 */
export function checkInstructionData(name: string, machine: AnyStateMachine, context: unknown): void {
  const declaring = allNodes(machine).filter((node) => metaOf(node)?.data !== undefined)
  // Where a transition with an effect lands: its target, or its source when it has none.
  const effects = allNodes(machine).flatMap((node) => agentTransitions(node).filter((t) => metaOf(t)?.effect).map((t) => t.target?.[0] ?? node))
  for (const node of allNodes(machine)) {
    const instructions = metaOf(node)?.instructions
    if (instructions === undefined) continue
    // Both arrivals owe the same keys: a `revisit` that names a key `first` does not is just as stale.
    const prose = (['first', 'revisit'] as const).map((visit) => resolveInstructions(instructions, context, visit, `'${node.id}'`) ?? '').join('\n')
    // At most one declarer is active at a time (checked at registration), but which one is not statically known,
    // so every declarer that could be active here owes every key this state's prose names.
    const suppliers = declaring.filter((d) => coActive(node, d))
    for (const key of new Set(dataNames(prose))) {
      if (suppliers.length === 0) {
        throw new Error(`Machine '${name}': instructions on '${node.id}' name 'data.${key}', but no state active there declares meta.data`)
      }
      // Registration has a context and no event, so a key a projection derives from an effect's `output` is absent here
      // by construction. The check declines on those rather than guess at an event: a supplier an effect can land on
      // may be short a key, and every other supplier still owes it.
      const short = suppliers.find((d) => !(key in emitted(name, d, context)) && !effects.some((landing) => coActive(landing, d)))
      if (short) {
        throw new Error(`Machine '${name}': instructions on '${node.id}' name 'data.${key}', which meta.data on '${short.id}' does not emit`)
      }
    }
  }
}

/**
 * One projection's key set, against the context registration has. A projection that reads a value the registration
 * context has not got would otherwise throw out of `createRuntime` unattributed — the same unread failure fixed one
 * layer out, and now reachable for every machine rather than only the one whose author wrote the test.
 */
function emitted(name: string, node: AnyStateNode, context: unknown): object {
  try {
    return (metaOf(node)!.data!({ context }) ?? {}) as object
  } catch (error) {
    throw new Error(`Machine '${name}': meta.data on '${node.id}' threw on the registration context: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Whether two nodes can be active at once: one contains the other, or they sit in different regions of a parallel node. */
function coActive(a: AnyStateNode, b: AnyStateNode): boolean {
  const lineage = (node: AnyStateNode): AnyStateNode[] => (node.parent ? [...lineage(node.parent), node] : [node])
  const aLine = lineage(a)
  const bLine = lineage(b)
  const shared = aLine.filter((node) => bLine.includes(node))
  const lca = shared[shared.length - 1]
  return lca === a || lca === b || lca?.type === 'parallel'
}

/**
 * The backstop for the one remaining way an actor changes under its driver (ADR-0008):
 * an `on` key no agent can ever send. The typed surface refuses all four spellings as the author types them, and this
 * is what catches a machine written in raw XState that never passed through it.
 *
 * The rule is `isAgentEvent` negated rather than a list of the four, so the two can never drift apart — the enumerator
 * decides what an agent is *offered* and this decides what may be *declared*, and they must be the same set. Two
 * descriptors are reserved by the runtime rather than by an author and are exempt: the tracking hook the root is
 * required to carry, and `onDone`, which XState spells `xstate.done.state.<id>` and which resolves inside the agent's
 * own settle rather than behind its back.
 */
const ON_DONE = 'xstate.done.state.'
/** The absorber the runtime spreads in: `xstate.error.actor.*` on the root, moving nothing and recording nothing. */
const absorbs = (root: boolean, descriptor: string, transitions: AnyTransitionDefinition[]) =>
  root && descriptor === CHILD_FAILED && transitions.every((t) => !t.target?.length && !t.actions.length)
function checkDescriptor(fail: (message: string) => never, node: AnyStateNode, root: boolean, descriptor: string, transitions: AnyTransitionDefinition[]) {
  if (isAgentEvent(descriptor) || descriptor === AGENT_PRESENTED || descriptor.startsWith(ON_DONE)) return
  if (absorbs(root, descriptor, transitions)) return
  fail(`'${descriptor}' on '${node.id}' is not an event an agent can send, so taking it would move the actor while its driver is away; wait for the children on the transition that needs them instead`)
}

function checkTransition(fail: (message: string) => never, source: AnyStateNode, t: AnyTransitionDefinition) {
  if (t.target && t.target.length > 1) {
    fail(`'${t.eventType}' from '${source.id}' has several targets; agent-facing transitions must name one`)
  }
  const meta = metaOf(t)
  if (meta?.schema !== undefined && !isSchemaMeta(meta.schema)) {
    fail(`meta.schema on '${t.eventType}' from '${source.id}' must be a zod object schema or a function of context returning one`)
  }
  if (declaresOutput(meta?.schema)) fail(`meta.schema on '${t.eventType}' from '${source.id}' declares 'output', which is reserved: it is what a transition's effect returned`)
}

/**
 * `output` is the runtime's to put on an event, as `settled` is. Only a schema written as a value can be read here; one
 * that is a function of context is resolved per call, and an effect's `output` is written over whatever it accepted.
 */
function declaresOutput(schema: unknown): boolean {
  return typeof schema === 'object' && schema !== null && 'output' in ((schema as { shape?: object }).shape ?? {})
}
