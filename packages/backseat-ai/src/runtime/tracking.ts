import { assign, enqueueActions } from 'xstate'
import type { ActionFunction } from 'xstate'
import { ID_SEPARATOR } from './registry.js'
import type { Collection } from './registry.js'
import type { SchemaMeta } from './schema.js'
import type { SettledSite, Site } from './sites.js'

/** Context slice the tracking hook maintains. Lives in machine context so it persists and is shared by every agent driving the actor. */
export type AgentTrackingContext = {
  /**
   * `"<eventType>-><targetId>"` pair to the rendered schema text last shown for it; re-shown when the text changes. The
   * target is the move's destination, or for a targetless move the node that declares it (ADR-0016).
   */
  shown: Record<string, string>
  /** State ids whose instructions have been presented at least once. */
  visited: string[]
  /**
   * `"<state> <eventType>-><targetId>"` to a digest of the move's rendered text, for each move printed whole while the
   * actor was in `<state>` (its active atomic state ids, comma-joined). A later response there prints that move by name
   * alone until its text changes (ADR-0016).
   */
  listed: Record<string, string>
  /** Whether this actor's driver has been given the drive protocol. Delivered once, on the first response it receives. */
  taught: boolean
}

/**
 * The reserved tracking event. With `eventType` it records the rendered `schema` text shown for the pair; with
 * `targetId` alone it records a visit to that state; with `protocol` it records that the drive protocol was delivered;
 * with `listed` it records the moves printed whole on this response, keyed and digested as `listed` in the context.
 */
export type AgentTrackingEvent =
  | { type: 'agent.presented'; targetId: string; eventType?: string; schema?: string }
  | { type: 'agent.presented'; protocol: true }
  | { type: 'agent.presented'; listed: Record<string, string> }

/** `meta` the runtime reads on state nodes and transitions. `TContext` types the `data` and `schema` functions' argument. */
export type AgentMeta<TContext = any> = {
  /**
   * Payload contract for entering the node / taking the transition: a zod object schema, or a function of context
   * returning one, resolved against the actor's current context wherever the schema is validated or rendered.
   */
  schema?: SchemaMeta<TContext>
  /**
   * What the agent is handed by arriving here, never while it is choosing where to go. `first` on the first visit,
   * `revisit` (or `first`) afterwards; a function is resolved where it is read and told which visit this is.
   */
  instructions?: InstructionsMeta<TContext>
  /**
   * Computes the value returned as `Summary.data` while the agent is in this state; the only way context reaches an agent.
   * At most one active state may declare it (checked at registration). `event` is the event the call that produced this
   * response sent — with the `output` its transition's effect returned — and is present on that one response alone:
   * a rejection, `snapshot`, `describe` and `create` pass none, so what it carries is shown once and never persisted.
   */
  data?: (args: { context: TContext; event?: { type: string; output?: unknown; [key: string]: unknown } }) => unknown
  /**
   * Transitions only, and only on an event an agent can send: the I/O the transition exists to do. Awaited after the
   * transition is selected and before XState sees the event; what it resolves to rides the event as `output`, to the
   * actions and to the landing state's `data`. It may throw `RejectedEvent` to refuse the event, and the actor does not move.
   */
  effect?: (args: { context: TContext; event: { type: string; [key: string]: unknown } }) => unknown
  /**
   * Input to snapshot this machine with at registration. Read on the **root node only**. Registration builds an initial
   * snapshot to check the tracking slice and the `data` projections, and it reaches spawn-only machines through
   * `setup({ actors })` — which have no input until a parent
   * spawns them. The default is `{}`, enough for any initializer that only reads properties off `input`; declare this
   * where one needs more, and registration fails naming the real error where neither is enough.
   */
  sampleInput?: unknown
  /** State nodes only: the spawn sites declared there, read by `createMachine` off the `spawnChild` actions each runs. */
  sites?: Site[]
  /** Transitions only: the sites whose children must all be settled before the transition may be taken. */
  settled?: SettledSite[]
}

/** Which arrival this is: the agent's first time in the state, or a later one. */
export type Visit = 'first' | 'revisit'
/** Declared as the text, or as a function told the context and which visit this is. */
export type InstructionsMeta<TContext = any> = string | ((args: { context: TContext; visit: Visit }) => string)

/** The prose for one arrival; `where` names the declaration if a function misbehaves. */
export function resolveInstructions(value: InstructionsMeta | undefined, context: unknown, visit: Visit, where: string): string | undefined {
  if (value === undefined) return undefined
  // A string is the whole of it, on every arrival. Saying something different on a revisit is what the function form
  // is for, and it is told which arrival this is.
  if (typeof value !== 'function') return value
  const resolved = value({ context, visit })
  if (typeof resolved !== 'string') throw new Error(`meta.instructions on ${where} must return a string`)
  return resolved
}

export const AGENT_PRESENTED = 'agent.presented' as const

export function shownKey(eventType: string, targetId: string): string {
  return `${eventType}->${targetId}`
}

/** The key a move printed whole is recorded under: the state the actor was in, then the move as its heading names it. */
export function listedKey(state: string, eventType: string, targetId: string): string {
  return `${state} ${shownKey(eventType, targetId)}`
}

function append(list: string[], item: string): string[] {
  return list.includes(item) ? list : [...list, item]
}

// Built outside any `setup()`, so its machine-specific generics are left open for the author's machine to fill in.
// The `never`s are the actors, actions, guards, delays and events it names, which is none, so it fits any machine.
const recordPresented = assign({
  agent: ({ context, event }: { context: { agent: AgentTrackingContext }; event: AgentTrackingEvent }) => {
    if ('protocol' in event) return { ...context.agent, taught: true }
    if ('listed' in event) return { ...context.agent, listed: { ...context.agent.listed, ...event.listed } }
    return event.eventType === undefined
      ? { ...context.agent, visited: append(context.agent.visited, event.targetId) }
      : { ...context.agent, shown: { ...context.agent.shown, [shownKey(event.eventType, event.targetId)]: event.schema ?? '' } }
  },
}) as ActionFunction<any, any, any, any, never, never, never, never, never>

/**
 * The descriptor a spawned child's failure arrives on. XState relays it to the parent and, unhandled, takes the parent
 * down with the child — so absorbing it is what lets a crashed worker be *collected* rather than fatal, which is the
 * whole of what the collection's `status` and `error` fields are for. It is the runtime's to write, not an author's:
 * ADR-0008 refuses this key at every authored `on`, and it is refused here too in any shape but this one — no target
 * and no actions, so nothing moves and nothing is recorded behind the agent's back.
 */
export const CHILD_FAILED = 'xstate.error.actor.*' as const

/** Spread `agentTracking.context` into the machine's context and `agentTracking.on` into its root `on`. */
export const agentTracking = {
  context: { agent: { shown: {}, visited: [], listed: {}, taught: false } as AgentTrackingContext },
  on: { [AGENT_PRESENTED]: { actions: recordPresented }, [CHILD_FAILED]: {} },
}

/**
 * Stops the children the gate collected, last in the transition's list — after the settle actions and the author's
 * own. This is what makes the format's definition of settled literally true ("no longer among its parent's children")
 * rather than approximated by reading status, and it runs *inside* the transition the agent sent, so XState still
 * processes no event the agent did not send. The runtime has already copied each child's outcome into the run record,
 * so stopping here loses nothing: `stopChild` deletes the child from the live and the persisted `children` map alike.
 */
export const stopCollected = enqueueActions((args: any) => {
  const { event, enqueue } = args as { event: { settled?: Collection[] }; enqueue: { stopChild: (id: string) => void } }
  for (const site of event?.settled ?? []) {
    for (const child of site.children) enqueue.stopChild(child.actorId.slice(child.actorId.lastIndexOf(ID_SEPARATOR) + 1))
  }
}) as ActionFunction<any, any, any, undefined, any, any, any, any, any>
