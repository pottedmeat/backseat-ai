import { createMachine, spawnChild as xstateSpawnChild } from 'xstate'
import type {
  ActionFunction,
  AnyStateMachine,
  DoneStateEvent,
  EventDescriptor,
  EventObject,
  ExtractEvent,
  InitialTransitionConfig,
  MachineContext,
  ParameterizedObject,
  ProvidedActor,
  SpawnActionOptions,
  StateMachine,
  StateNodeConfig,
  StateSchema,
  ToStateValue,
  TransitionConfig,
} from 'xstate'
import { agentTracking, checkSites, noteSpawn, stopCollected, validateMachine } from '../runtime/index.js'
import type { AgentMeta, AgentTrackingContext, AgentTrackingEvent, Collection, InstructionsMeta, SchemaMeta, Site } from '../runtime/index.js'

/**
 * A machine is **one TypeScript value**, and this is the `createMachine` that lowers it into XState's. Backseat's
 * keys — `instructions`, `data`, `schema` — are first-class on the value; moving them under `meta` is
 * what this call does, and the rest of `meta` is the author's, carried through beside them. The runtime reads the
 * lowered machine at a fixed set of paths and those are produced unchanged.
 *
 * It is also where a machine is *verified*. Every check registration once ran on its own — the spawn sites, the root
 * description and tracking hook, the initial snapshot, the `data` projections and the keys the instructions name —
 * runs here, so importing a module of machines is the whole of checking them and there is no pass to forget.
 *
 * Spawning is XState's own, with nothing of Backseat's in it: the author writes XState's `spawnChild('worker')` in an
 * ordinary action list, and lowering reads the site back off the action it returns (a callable carrying
 * `type: 'xstate.spawnChild'` and `src`). Nothing is declared. `actors` is XState's roster, with XState's signature.
 * The name matters because it is the only thing about a child that survives persistence — `spawnChild(logic)` inlines
 * the whole machine into the run record and cannot be rehydrated — so a name not on the roster throws from this call,
 * naming the ones that are.
 *
 * `collectChildren` is its mirror: an action on a transition that both gates it — the transition may not be taken while any
 * child spawned at that site is still running — and hands the children's outcomes to the actions it wraps.
 */

// ---- the authored shape -------------------------------------------------------------------------------------------

/** Payload contract on a state or transition: a zod object, or a function of context returning one. */
export type Schema<C> = SchemaMeta<C>
export type { Visit } from '../runtime/index.js'
/**
 * What a state or transition hands the agent by being reached. A string says the same thing every time; a function is
 * told which arrival this is, and is the only way to say something different on a revisit.
 */
export type Instructions<C> = InstructionsMeta<C>

/** The `event` a collected action receives: the agent's, plus the outcomes of the children that settled. */
export type Settled<E> = E & { settled: Collection[] }

/**
 * The event as the agent sent it, before an effect has run: what a guard and the effect itself are handed. An event
 * type that declares `output` declares what its effect returns, and nothing has returned it yet.
 */
export type Sent<Ev> = Ev extends unknown ? Omit<Ev, 'output'> : never
/**
 * The I/O a transition exists to do, run inside the call that sends its event. What it resolves to reaches the
 * transition's actions and the landing state's `data` as `event.output`, typed by the `output` the event type declares;
 * throwing `RejectedEvent` refuses the event.
 */
export type Effect<C, Ev> = (args: { context: C; event: Sent<Ev> }) => Ev extends { output: infer O } ? O | Promise<O> : unknown
/**
 * The effect's key on a transition: required where the event type declares `output`, since nothing else produces it,
 * optional where it does not, and refused on `always`, which no agent sends.
 */
type EffectKey<C, Ev, On extends boolean> = On extends false
  ? { effect?: AnEffectRunsOnlyOnAnEventAnAgentSends<'effect'> }
  : Ev extends { output: unknown }
    ? { effect: Effect<C, Ev> }
    : { effect?: Effect<C, Ev> }

interface NotAKeyOfABackseatState<K extends PropertyKey> {
  readonly __backseat__: K
}
interface NotAKeyOfABackseatTransition<K extends PropertyKey> {
  readonly __backseat__: K
}

/**
 * `after` and `invoke` are refused, and each type's own name is the message. Both move the actor while the agent
 * driving it is away — a delay fires on a timer, an invoked actor completes whenever it completes — so the response the
 * agent last read becomes quietly untrue, which ADR-0008 makes a law of the format rather than a matter of taste.
 *
 * Neither works today either, which is why these are refusals and not a design. The CLI rehydrates per invocation
 * (ADR-0003), so no process exists for a timer to fire in; XState never persists a pending delay and its restore path
 * for one is unreachable; and a restored `invoke` re-runs its actor on every rehydration. Revisit `after` if a daemon
 * ever fronts the store *and* the runtime gains a way to tell an agent that it is waiting and what to wait for.
 */
interface NoTimerFiresBetweenInvocations<K extends PropertyKey> {
  readonly __backseat__: K
}
/** A child is spawned and collected: `spawnChild` in an action, `collectChildren` on the transition that reads it. */
interface SpawnAndCollectRatherThanInvoke<K extends PropertyKey> {
  readonly __backseat__: K
}
/**
 * A target names a sibling, and the root has none. XState refuses a plain name from the root at build time, and the
 * form it asks for instead (`'.state'`) is no sibling's name either, so the only thing a target here could ever do is
 * throw. A transition on the root is offered from every state; it may act, but it moves nothing.
 */
interface WriteATargetedTransitionOnAChildState<K extends PropertyKey> {
  readonly __backseat__: K
}
/**
 * An effect runs inside the call that sends its event, and nothing sends `always`: there is no call for it to run in,
 * and running it anyway would change the world while the agent is away (ADR-0008).
 */
interface AnEffectRunsOnlyOnAnEventAnAgentSends<K extends PropertyKey> {
  readonly __backseat__: K
}
/** A node's own `target` is a history state's default, and means nothing on any other node. */
interface OnlyAHistoryStateHasADefaultTarget<K extends PropertyKey> {
  readonly __backseat__: K
}
/**
 * XState's type lets an initial transition carry anything a transition can, and its `formatInitialTransition` reads
 * `target` and `actions` alone: a `guard` never gates, `reenter` is fixed at false, and `description` and `meta` go
 * nowhere. Each is refused by name rather than typed and dropped.
 */
interface AnInitialTransitionRunsOnlyItsTargetAndActions<K extends PropertyKey> {
  readonly __backseat__: K
}

/**
 * An `on` key no agent can ever send, and so the last way the states and transitions available to an agent change
 * without the agent knowing (ADR-0008). Four spellings: a spawned child's `xstate.done.actor.*` and
 * `xstate.error.actor.*`, the runtime's own `agent.` space, and every catch-all — a bare `*` or a partial `brief.*`,
 * which also swallows an ancestor's `onDone`. `EventDescriptor<E>` always contributes `'*'` whatever the author's
 * union says, so the refusal has to live on the key itself rather than on the event type.
 */
interface NotAnEventAnAgentCanSend<K extends PropertyKey> {
  readonly __backseat__: K
}

/**
 * An `on` key outside the machine's own event union. XState accepts one and lowers it, and the excess-property check
 * that was supposed to catch it only fires when the state has no valid key left beside it — so a misspelled event on a
 * state with a second, correct one compiled completely clean (measured). Branded for the same reason state and
 * transition keys are: a key the runtime will never route is a mistake, and silence is the one outcome worse than a
 * bad message.
 */
interface NotAnEventThisMachineDeclares<K extends PropertyKey> {
  readonly __backseat__: K
}

/**
 * A key under `meta` that lowering writes and the runtime reads. The rest of `meta` is the author's, as it is in XState,
 * and is carried through beside Backseat's keys; these seven would be obeyed by the runtime without the typed surface
 * that writes them, so each is refused by name and told where it is written instead.
 */
interface ReservedForBackseat<K extends PropertyKey> {
  readonly __backseat__: K
}

/** `meta` as authored: anything of the author's own, and none of the keys lowering puts there. */
type AuthoredMeta = { [key: string]: unknown } & { [K in keyof AgentMeta]?: ReservedForBackseat<K> }

/** The runtime's `isAgentEvent` negated, as a type: true for the descriptors no agent can put on the wire. */
type Reserved<D> = D extends '*' ? true : D extends `${string}.*` ? true : D extends `xstate.${string}` ? true : D extends `agent.${string}` ? true : false

/**
 * XState's node type with the parameters this surface fixes. Actions, guards and delays are `never`: an author hands
 * over the value, never a name, so a string at an action position is a compile error rather than a silently unbound
 * name at run time.
 */
type XNode<C extends MachineContext, E extends EventObject> = StateNodeConfig<C, E, ProvidedActor, never, never, never, string, unknown, E, AgentMeta>

type Action<C extends MachineContext, Ev extends EventObject, E extends EventObject> = ActionFunction<C, Ev, E, undefined, ProvidedActor, never, never, never, E>

/** What `collectChildren` returns: a marker lowering replaces with the actions it wraps, having read the site off it. */
declare const COLLECT: unique symbol
export type Collect<C extends MachineContext, Ev extends EventObject, E extends EventObject> = {
  readonly [COLLECT]: [C, Ev, E]
}

/**
 * Gate this transition on every child of `machine` spawned at `state` having settled, and hand their outcomes to
 * `actions` as `event.settled`. While any is still running the transition is refused, naming what is pending.
 *
 * Both halves of the site are named, because a site is a state *and* a machine: the state a child was spawned at is
 * what tells one round's children from another's, and it is not always the state this transition leaves.
 */
export function collectChildren<C extends MachineContext, Ev extends EventObject, E extends EventObject>(state: string, machine: string, ...actions: Array<Action<C, Settled<Ev>, E>>): Collect<C, Ev, E> {
  return { state, src: machine, actions } as never
}

type StatesOf<T> = T extends { states: infer St } ? St : never

/**
 * A transition as written under `on` or `always`. The actions see the event whole, `output` included; the guard sees it
 * as sent, being evaluated before the effect runs.
 */
type TxBase<Names, C extends MachineContext, E extends EventObject, Ev extends EventObject, On extends boolean = true> = Omit<
  TransitionConfig<C, Sent<Ev> & EventObject, E, ProvidedActor, never, never, never, E, AgentMeta>,
  // adjusted
  'target' | 'meta' | 'actions'
> & {
  // adjusted: `target` names a sibling of the node the transition is written on
  target?: Names
  meta?: AuthoredMeta
  actions?: Action<C, Ev, E> | Collect<C, Ev, E> | Array<Action<C, Ev, E> | Collect<C, Ev, E>>
} &
  // added: `instructions` and `schema` as the runtime declares them, and `effect` where an agent sends the event
  Pick<AgentMeta<C>, 'instructions' | 'schema'> &
  EffectKey<C, Ev, On>

/**
 * A transition the agent is never offered, and so carries none of the three keys that mean anything only on one it
 * took: `schema` would validate a payload nothing sends, `instructions` is read off the transition the agent chose,
 * and `collectChildren` gates on children the agent asked about. Lowering visits `on` and `always` alone, so accepting any of
 * the three here would drop it in silence, which is the one outcome worse than refusing it.
 */
type TxInternal<Names, C extends MachineContext, E extends EventObject, Ev extends EventObject> = Omit<
  TransitionConfig<C, Ev, E, ProvidedActor, never, never, never, E, AgentMeta>,
  // adjusted
  'target' | 'meta' | 'actions'
> & {
  // adjusted: `target` names a sibling of the compound state `onDone` is written on
  target?: Names
  meta?: AuthoredMeta
  actions?: Action<C, Ev, E> | Array<Action<C, Ev, E>>
}

type ExactTx<T, Names, C extends MachineContext, E extends EventObject, Ev extends EventObject, On extends boolean> = TxBase<Names, C, E, Ev, On> & {
  [P in Exclude<keyof T, keyof TxBase<Names, C, E, Ev, On>>]: NotAKeyOfABackseatTransition<P>
}

type ExactInternalTx<T, Names, C extends MachineContext, E extends EventObject, Ev extends EventObject> = TxInternal<Names, C, E, Ev> & {
  [P in Exclude<keyof T, keyof TxInternal<Names, C, E, Ev>>]: NotAKeyOfABackseatTransition<P>
}

/**
 * The slot under one event key, computed from what the author wrote there: an object, or a contest (an array). `On` is
 * whether an agent sends this key — every `on` key does, `always` does not — and so whether an effect may be written.
 */
type TxSlot<T, Names, C extends MachineContext, E extends EventObject, Base extends EventObject, On extends boolean = true> = T extends readonly unknown[]
  ? { [I in keyof T]: ExactTx<T[I], Names, C, E, Base, On> }
  : ExactTx<T, Names, C, E, Base, On>

/** The same, for the one door the agent is never offered: `onDone`, written on the compound state it leaves. */
type InternalTxSlot<T, Names, C extends MachineContext, E extends EventObject, Base extends EventObject> = T extends readonly unknown[]
  ? { [I in keyof T]: ExactInternalTx<T[I], Names, C, E, Base> }
  : ExactInternalTx<T, Names, C, E, Base>

/**
 * `initial` in XState's transition-object form: a child's name, as XState's own lookup requires, and actions that run
 * only when the region is entered by default. A `spawnChild` among them is a site of the node it is written on.
 */
type InitialTx<Names, C extends MachineContext, E extends EventObject> = Omit<
  InitialTransitionConfig<C, E, ProvidedActor, never, never, never>,
  // refused: XState reads `target` and `actions` alone on an initial transition
  | 'guard' | 'reenter' | 'meta' | 'description'
  // adjusted
  | 'target' | 'actions'
> & {
  // adjusted: `target` names a child of the node `initial` is written on
  target: Names
  actions?: Action<C, E, E> | Array<Action<C, E, E>>
}

type ExactInitialTx<T, Names, C extends MachineContext, E extends EventObject> = InitialTx<Names, C, E> & {
  [P in Exclude<keyof T, keyof InitialTx<Names, C, E>>]: AnInitialTransitionRunsOnlyItsTargetAndActions<P>
}

/**
 * A state node as authored, checked against its siblings `St`; `Extra` names the keys the root alone may carry, and
 * `Tg` is what a transition written here may target — the siblings, everywhere but the root, which has none.
 */
type SupNode<St, C extends MachineContext, E extends EventObject, T, Extra extends PropertyKey = never, Tg = keyof St & string> = Omit<
  XNode<C, E>,
  // refused
  | 'after' | 'invoke'
  // adjusted
  | 'meta' | 'target' | 'initial' | 'on' | 'always' | 'onDone' | 'states'
> & {
  // refused
  after?: NoTimerFiresBetweenInvocations<'after'>
  invoke?: SpawnAndCollectRatherThanInvoke<'invoke'>
  // adjusted
  meta?: AuthoredMeta
  // Both forms, always: while `T` is still being inferred it has no `initial`, and narrowing on it then would type every
  // string as the object form and cost the whole value its contextual typing. Once a string is written, the object
  // form drops out, so a misspelled name is reported against the child names alone.
  initial?: (keyof StatesOf<T> & string) | (T extends { initial: infer In } ? (In extends string ? never : ExactInitialTx<In, keyof StatesOf<T> & string, C, E>) : InitialTx<keyof StatesOf<T> & string, C, E>)
  /** A history state's default. The same rule as every other target: it names a sibling. No other node has one. */
  target?: T extends { type: 'history' } ? keyof St & string : OnlyAHistoryStateHasADefaultTarget<'target'>
  /**
   * The way out of a compound state, taken when its region reaches a final child. It is written on the compound state
   * itself, so its `target` is that state's own siblings — which is both the set an author wants and the set XState
   * resolves a plain-string target against. Nothing was ever wrong with the rule here; it was simply never applied.
   */
  onDone?: InternalTxSlot<T extends { onDone: infer Dn } ? Dn : unknown, Tg, C, E, DoneStateEvent>
  on?: {
    [D in EventDescriptor<E>]?: Reserved<D> extends true ? NotAnEventAnAgentCanSend<D> : TxSlot<T extends { on: infer O } ? (D extends keyof O ? O[D] : unknown) : unknown, Tg, C, E, ExtractEvent<E, D>>
  } & {
    [P in Exclude<T extends { on: infer O } ? keyof O : never, EventDescriptor<E>>]: Reserved<P> extends true ? NotAnEventAnAgentCanSend<P> : NotAnEventThisMachineDeclares<P>
  }
  always?: TxSlot<T extends { always: infer A } ? A : unknown, Tg, C, E, E, false>
  states?: { [K in keyof StatesOf<T>]: SupNode<StatesOf<T>, C, E, StatesOf<T>[K]> }
  // added, with `instructions` and `schema` below, as the runtime declares them
  /**
   * What the agent is handed in this state. `context` is what persists; `event` is present only on the response to the
   * send that carried it — with the `output` of that transition's effect — so what `data` shows from it is shown once.
   */
  data?: (args: { context: C; event?: E }) => unknown
} & Pick<AgentMeta<C>, 'instructions' | 'schema'> & {
  // anything else the author wrote
  [P in Exclude<keyof T, keyof XNode<C, E> | 'instructions' | 'data' | 'schema' | Extra>]: NotAKeyOfABackseatState<P>
}

type RootKeys = 'context' | 'actors'

/** The whole value, as the constraint on `createMachine`'s one type parameter. */
export type Authored<Cfg, C extends MachineContext, E extends EventObject, I> = SupNode<StatesOf<Cfg>, C, E, Cfg, RootKeys, WriteATargetedTransitionOnAChildState<'target'>> & {
  /**
   * XState's machine id. Not the catalog name: a project registers a machine under a name of its own choosing, and
   * being absent from that record is the whole of what keeps a machine out of the catalog.
   */
  id: string
  description: string
  /** XState's, unchanged. An initializer that reads its input carries a sample for registration: `withCheckInput`. */
  context: C | ((args: { input: I }) => C)
  /** XState's roster, with XState's signature: the machines this one spawns, by the name `spawnChild` uses. */
  actors?: Record<string, AnyStateMachine>
}

/** What comes out: an ordinary XState machine, with its state value and `getMeta()` typed. */
export type Machine<C extends MachineContext, E extends EventObject, Cfg extends StateSchema> = StateMachine<
  C & { agent: AgentTrackingContext },
  E | AgentTrackingEvent,
  Record<string, never>,
  ProvidedActor,
  ParameterizedObject,
  ParameterizedObject,
  string,
  ToStateValue<Cfg>,
  string,
  unknown,
  unknown,
  EventObject,
  AgentMeta & { [key: string]: unknown },
  Cfg
>

/** What `spawnChild`'s callbacks are handed. Annotating them is what XState's own requires; these are already typed. */
type SpawnArgs<C extends MachineContext, E extends EventObject> = { context: C; event: E }
export type SpawnOptions<C extends MachineContext, E extends EventObject> = Omit<
  SpawnActionOptions<C, E, E, ProvidedActor>,
  // refused
  | 'syncSnapshot'
  // adjusted
  | 'id' | 'input'
> & {
  // adjusted: the callbacks are handed `context` and `event` already typed
  /**
   * The key the child is filed under in its parent, and the last segment of its actor id. Required: XState files a
   * child without one under `"undefined"`, and a second child under a key that already holds one replaces it, leaving
   * the first running and held by nothing. Unique among the children the parent holds at once.
   */
  id: string | ((args: SpawnArgs<C, E>) => string)
  input?: Record<string, unknown> | ((args: SpawnArgs<C, E>) => unknown)
  // added
  /**
   * What this child is for, in the parent's words — the one place the parent can say what *this* child was handed,
   * which a state-level `data` projection cannot, being unable to tell two children apart. It never reaches the child:
   * `input` is that. The parent is told it once, on the call that spawns, and it is kept on the run record and carried
   * into the collection, so a child that broke still says what it was for. Absent, the child's resolved `input` stands
   * in. Resolved at the spawn, not when the child is filed — the difference is one child.
   */
  about?: Record<string, unknown> | ((args: SpawnArgs<C, E>) => unknown)
}

/**
 * `backseat<Context, Event, Input>()` fixes the types; `.createMachine(value)` takes the one value. Two calls because
 * TypeScript cannot infer the value's type while the context and event types are supplied.
 *
 * `spawnChild` comes back with it because XState cannot type its own: at a bare call site the `context` inside
 * `input` and `id` is an implicit `any`, in `setup().createMachine` as much as here (measured). It is XState's
 * `spawnChild`, returning XState's action — only with the types the call site cannot infer.
 */
export function backseat<C extends MachineContext, E extends EventObject, I = unknown>() {
  return {
    createMachine<const Cfg extends Authored<Cfg, C, E, I>>(config: Cfg): Machine<C, E, Extract<Cfg, StateSchema>> {
      return lower(config as unknown as RootValue) as never
    },
    spawnChild(src: string, options: SpawnOptions<C, E>): Action<C, E, E> {
      const action = xstateSpawnChild(src as never, options as never)
      // XState drops an option it does not know, so `about` cannot ride to the spawn inside its own call. It rides on
      // the action object instead — which XState ignores and lowering reads back, exactly as `src` is read back.
      if (options.about !== undefined) (action as { [ABOUT]?: unknown })[ABOUT] = options.about
      return action as never
    },
    /**
     * A transition written outside the value, for reuse. A `const` out there has no contextual type, so its actions
     * would see `AnyEventObject` and the use site would fail without naming why; this hands it the type of the event
     * it is written for. The target is checked where the transition is used, since only there are its siblings known.
     */
    transition<D extends E['type']>(event: D) {
      return <const T extends TxBase<string, C, E, ExtractEvent<E, D>>>(tx: T): T => tx
    },
    /**
     * The context initializer, carrying the input registration builds this machine's initial snapshot with. Needed
     * only where the initializer reads what it is handed, since the default is `{}`. It rides on the function, as
     * `about` rides on the spawn, so `context` stays XState's own function form.
     */
    withCheckInput(initializer: (args: { input: I }) => C, checkInput: I): (args: { input: I }) => C {
      return Object.assign((args: { input: I }) => initializer(args), { [CHECK_INPUT]: checkInput })
    },
  }
}

// ---- lowering -----------------------------------------------------------------------------------------------------

type Value = Record<string, unknown>
type RootValue = Value & { id: string; actors?: Record<string, AnyStateMachine> }
type SpawnAction = { type: 'xstate.spawnChild'; src: unknown; id?: unknown }
type CollectMarker = { state: string; src: string; actions: unknown[] }

const isObject = (value: unknown): value is Value => typeof value === 'object' && value !== null && !Array.isArray(value)
const toList = (value: unknown): unknown[] => (value === undefined ? [] : Array.isArray(value) ? value : [value])
const defined = (entries: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined))
const isCollect = (value: unknown): value is CollectMarker => isObject(value) && typeof value['src'] === 'string' && typeof value['state'] === 'string' && Array.isArray(value['actions'])
/** `spawnChild(...)` returns a callable carrying its own `src`; that is how a site is read back rather than declared. */
const spawnSrc = (value: unknown): string | undefined => {
  const action = value as SpawnAction | undefined
  return typeof value === 'function' && action?.type === 'xstate.spawnChild' && typeof action.src === 'string' ? action.src : undefined
}

/** Where `about` rides from the call site to here: a key XState neither reads nor copies. */
const ABOUT = Symbol.for('backseat.about')
const spawnAbout = (value: unknown): unknown => (value as { [ABOUT]?: unknown })?.[ABOUT]
const CHECK_INPUT = Symbol.for('backseat.checkInput')

/** Every key the runtime reads under `meta`, with where the author writes it instead. Keyed by `AgentMeta`, so a key added there must be added here. */
const reservedMeta: { [K in keyof Required<AgentMeta>]: string } = {
  instructions: 'write it beside meta, not under it',
  data: 'write it beside meta, not under it',
  schema: 'write it beside meta, not under it',
  effect: 'write it beside meta, on the transition, not under it',
  sites: 'a site is read off the spawnChild actions a state runs',
  settled: 'a transition is gated by collectChildren in its actions',
  sampleInput: 'pass it to withCheckInput with the context initializer',
}

/** The author's `meta`, having refused any key that is Backseat's to write. */
function authoredMeta(meta: unknown, at: string, fail: (at: string, message: string) => never): Value {
  if (meta === undefined) return {}
  if (!isObject(meta)) return fail(at, 'meta is an object')
  for (const key of Object.keys(meta)) {
    if (key in reservedMeta) fail(at, `'${key}' under meta is Backseat's to write: ${reservedMeta[key as keyof AgentMeta]}`)
  }
  return meta
}

/**
 * The note action that lands a spawn's `about` for the filing below it, placed immediately after the spawn so it reads
 * the context the spawn read. It cannot be returned *with* the spawn from `spawnChild` — XState silently drops a nested
 * array inside an action list, spawning nothing and reporting no error (measured) — so the pair is built here, where
 * lowering owns the flat list, on the same footing as the `stopCollected` a collecting transition gains.
 */
const withNotes = (actions: unknown): unknown[] =>
  toList(actions).flatMap((action) => {
    const src = spawnSrc(action)
    const about = spawnAbout(action)
    if (src === undefined || about === undefined) return [action]
    const note = ({ context, event, self }: { context: unknown; event: unknown; self: unknown }) =>
      noteSpawn(self, src, typeof about === 'function' ? (about as (args: unknown) => unknown)({ context, event }) : about)
    return [action, note]
  })

class LoweringError extends Error {
  constructor(machine: string, at: string, message: string) {
    super(`${machine}: ${at}: ${message}`)
    this.name = 'LoweringError'
  }
}

function lower(value: RootValue): AnyStateMachine {
  const { actors: roster = {}, ...config } = value
  const initializer = typeof value['context'] === 'function' ? (value['context'] as { [CHECK_INPUT]?: unknown }) : undefined
  const checkInput = initializer?.[CHECK_INPUT]
  const fail = (at: string, message: string): never => {
    throw new LoweringError(value.id, at, message)
  }
  const names = Object.keys(roster)
  const known = (src: string, at: string) => {
    // XState resolves a spawn by name through `actors` and says nothing useful when the name is not there.
    if (!(src in roster)) fail(at, `spawnChild('${src}') names no machine on this one's roster${names.length ? `, which holds ${names.map((n) => `'${n}'`).join(', ')}` : ', which is empty'}`)
  }
  const root = node(config, '', true, known, fail)
  const rootMeta = defined({ ...(root['meta'] as Value | undefined), sampleInput: checkInput })
  if (Object.keys(rootMeta).length) root['meta'] = rootMeta
  const machine = createMachine(root as never, { actors: roster } as never)
  // Once targets resolve: every collect names a site that exists, and every site is collected by some transition.
  // `checkSites` warns about one thing only — a roster entry no site uses — and that is an error here rather than a
  // warning, because the roster is written by hand on this very value: a name on it that nothing spawns is a mistake,
  // not a guess about what some file might have exported.
  const sites = checkSites(machine, names)
  const wrong = [...sites.errors, ...sites.warnings]
  if (wrong.length) throw new LoweringError(value.id, 'spawning', wrong.join('\n'))
  // Everything registration used to check, checked here: building the machine *is* the verification, so there is no
  // pass to forget to run and no command that reports what an import would have thrown.
  try {
    validateMachine(value.id, machine)
  } catch (error) {
    // Registration builds the initial snapshot with `{}` when no sample was given, which is enough unless the
    // initializer reads its input. That is the likeliest cause here, and the fix is ours to name.
    const message = error instanceof Error ? error.message : String(error)
    if (initializer && checkInput === undefined && message.includes('could not compute the initial snapshot')) {
      throw new LoweringError(value.id, 'context', `${message}\nRegistration ran the context initializer with an empty input. If it reads its input, wrap it: context: withCheckInput(({ input }) => …, sampleInput), with withCheckInput from backseat<…>().`)
    }
    throw error
  }
  return machine
}

function node(value: Value, path: string, root: boolean, known: (src: string, at: string) => void, fail: (at: string, message: string) => never): Value {
  const { instructions, data, schema, meta: authored, states, on, always, ...rest } = value
  const out: Value = { ...rest }
  const here = (key: string) => (path ? `${path}.${key}` : key)
  const own = authoredMeta(authored, here('meta'), fail)
  const sites: Site[] = []
  /** A site is read back off the `spawnChild` actions this state runs — on entry, on its initial, or on a transition it owns. */
  const site = (actions: unknown, at: string) => {
    for (const action of toList(actions)) {
      const src = spawnSrc(action)
      if (src === undefined) continue
      known(src, at)
      // XState's own `spawnChild` takes no id as readily as one; this is where it is caught, as the typed one is by tsc.
      if ((action as SpawnAction).id === undefined) fail(at, `spawnChild('${src}') has no id. XState files a child without one under "undefined", where the next replaces it. Give it one unique among the children this machine holds at once`)
      if (!sites.some((s) => s.src === src)) sites.push({ src })
    }
  }
  site(out['entry'], here('entry'))
  if (out['entry'] !== undefined) out['entry'] = withNotes(out['entry'])
  const initial = out['initial']
  if (isObject(initial) && initial['actions'] !== undefined) {
    site(initial['actions'], here('initial'))
    out['initial'] = { ...initial, actions: withNotes(initial['actions']) }
  }
  if (on !== undefined || root) {
    const lowered = Object.fromEntries(
      Object.entries((on as Value | undefined) ?? {}).map(([key, slot]) => {
        for (const t of toList(slot)) site((t as Value)?.['actions'], here(`on.${key}`))
        return [key, slots(slot, here(`on.${key}`), fail)]
      }),
    )
    out['on'] = root ? { ...lowered, ...agentTracking.on } : lowered
  }
  if (always !== undefined) {
    for (const t of toList(always)) site((t as Value)?.['actions'], here('always'))
    out['always'] = slots(always, here('always'), fail)
  }
  // `onDone` passes through to XState as written, so a Backseat key that got past its type would be dropped in silence.
  for (const [i, t] of toList(out['onDone']).entries()) {
    const at = here(Array.isArray(out['onDone']) ? `onDone[${i}]` : 'onDone')
    if (!isObject(t)) continue
    for (const key of ['effect', 'schema', 'instructions'] as const) if (t[key] !== undefined) fail(at, `'${key}' means nothing on onDone, which no agent sends`)
    if (toList(t['actions']).some(isCollect)) fail(at, 'collectChildren means nothing on onDone, which no agent sends')
    authoredMeta(t['meta'], `${at}.meta`, fail)
  }
  const meta = defined({ ...own, instructions, data, schema, sites: sites.length ? sites : undefined })
  if (Object.keys(meta).length) out['meta'] = meta
  if (states !== undefined) out['states'] = Object.fromEntries(Object.entries(states as Value).map(([child, node_]) => [child, node(node_ as Value, here(`states.${child}`), false, known, fail)]))
  if (root) out['context'] = context(value['context'])
  return out
}

/** The tracking slice is spread in beside the authored context, whether it is a value or a factory of `input`. */
function context(authored: unknown): unknown {
  if (typeof authored === 'function') return (args: unknown) => ({ ...agentTracking.context, ...(authored as (args: unknown) => object)(args) })
  if (isObject(authored)) return { ...agentTracking.context, ...authored }
  return { ...agentTracking.context }
}

function slots(slot: unknown, path: string, fail: (at: string, message: string) => never): unknown {
  return Array.isArray(slot) ? slot.map((item, i) => transition(item, `${path}[${i}]`, fail)) : transition(slot, path, fail)
}

function transition(value: unknown, path: string, fail: (at: string, message: string) => never): unknown {
  if (!isObject(value)) return fail(path, 'a transition is an object; write { target } rather than a bare name')
  const { schema, instructions, effect, actions, meta: authored, ...rest } = value
  const out: Value = { ...rest }
  if (effect !== undefined && typeof effect !== 'function') fail(`${path}.effect`, 'an effect is a function of { context, event }')
  const meta = defined({ ...authoredMeta(authored, `${path}.meta`, fail), schema, instructions, effect })
  // `collect` is Backseat's, not XState's: unwrapped here into the actions it holds, with the site it gates on carried
  // on the transition's meta for the runtime to read, and the collected children stopped last.
  const collected = toList(actions).filter(isCollect)
  if (collected.length) {
    meta['settled'] = collected.map((entry) => ({ state: entry.state, src: entry.src }))
    out['actions'] = [...withNotes(toList(actions).flatMap((action) => (isCollect(action) ? action.actions : [action]))), stopCollected]
  } else if (actions !== undefined) out['actions'] = withNotes(actions)
  if (Object.keys(meta).length) out['meta'] = meta
  return out
}
