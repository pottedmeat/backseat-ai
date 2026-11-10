# Writing a machine

A Backseat machine is one TypeScript value: an XState config with a few keys of Backseat's own. This page covers those
keys, and how XState's are narrowed is in [`xstate.md`](./xstate.md). A machine that hands work to subagents also
spawns and collects children, which [`subagents.md`](./subagents.md) covers.

## `backseat()` and `createMachine`

```ts demos/one-value/effects.ts
export const reader = backseat<Ctx, Ev>().createMachine({
  id: 'reader',
  description: 'Reads notes off a shelf, leaves one behind, and says when it is done.',
  context: { reads: [] },
  initial: 'reading',
```

It takes two calls. `backseat<Context, Event, Input>()` fixes the types, and `.createMachine(value)` takes the machine.
TypeScript can't infer the value's type while you're also supplying the context and event types, so they come in
separate calls. `Input` is optional. It types the `input` a `context` function is handed, and the sample
[`withCheckInput`](#withcheckinput) takes.

The first call also returns `spawnChild`, `withCheckInput` and [`transition`](#transition), typed for this machine:

```ts demos/one-value/one-value.ts
const { createMachine, spawnChild: spawnWorker } = backseat<LeadContext, LeadEvent>()
```

**Building the machine checks it.** `createMachine` runs every check that needs the whole machine: the spawn sites, the
`data` names in instructions, the initial snapshot, and the reserved names below. A mistake throws from the call, so
importing a file of machines is how you check them. There's no separate step to forget.

### The root

The root needs `id`, `description` and `context`, and it may carry `actors`. It may also carry XState's `output`,
unchanged: what a finished actor returns, and what a parent collects from a child
([`xstate.md`](./xstate.md#every-machine-uses-these)).

The four are typed like this:

```ts packages/backseat-ai/src/compiler/machine.ts
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
```

The value's type is `Authored`, and what comes back is `Machine`: an ordinary XState machine with its state value and
`getMeta()` typed. Its context and events also carry Backseat's tracking slice and the `agent.presented` event, which
record what the agent has been shown. Your own `Context` and `Event` types never include them.

```ts packages/backseat-ai/src/compiler/machine.ts
export type Machine<C extends MachineContext, E extends EventObject, Cfg extends StateSchema> = StateMachine<
  C & { agent: AgentTrackingContext },
  E | AgentTrackingEvent,
```

A misspelled key is a compile error that names itself, and so is a target that isn't a sibling:

```text packages/backseat-ai/src/compiler/machine.test.ts
error TS2820: Type '"reviewng"' is not assignable to type '"briefing" | "dispatching" | "done" | "reviewing" | undefined'. Did you mean '"reviewing"'?
```

## The keys Backseat adds

| Key | Where | Type |
| --- | --- | --- |
| [`instructions`](#instructions) | state, transition | `Instructions<C>` |
| [`data`](#data) | state | `({ context, event }) => unknown` |
| [`schema`](#schema) | state, transition | `Schema<C>` |
| [`effect`](#effect) | a transition under `on` | `Effect<C, Ev>`, required where the event type declares `output` |

A state's `description` is what the agent reads while it decides whether to go there, so building the machine refuses
a state a move can reach that has none. These four are what it's handed once it has gone, and what it has to send to
go further.

## `instructions`

What the agent is handed **by arriving** in a state or taking a transition: what to do now that it's here. It reads a
`description` before it moves, but it can't see `instructions` until it has committed to the move.

```ts packages/backseat-ai/src/runtime/tracking.ts
/** Which arrival this is: the agent's first time in the state, or a later one. */
export type Visit = 'first' | 'revisit'
/** Declared as the text, or as a function told the context and which visit this is. */
export type InstructionsMeta<TContext = any> = string | ((args: { context: TContext; visit: Visit }) => string)
```

These are exported as `Visit` and `Instructions<C>`. A string says the same thing on every arrival. To say something
different on a later one, write the function, which is told the context and whether this is the first visit:

```ts demos/one-value/one-value.ts
instructions: ({ context, visit }) =>
  visit === 'first'
    ? 'A worker holds `data.current`. Spawn a subagent and give it the listed command, so the worker\'s ' +
      'work stays out of your context and the workers run side by side. Move on to the next item, or to ' +
      'the review once none are left: the review waits until every worker is back.'
    : context.items.length
      ? '`data.remaining` still to dispatch.'
      : 'Nothing left to dispatch; move on to the review.',
```

The agent reads exactly what you wrote. Nothing in it is expanded or rewritten.

**A `data.<key>` in backticks is checked.** When the machine is built, every `` `data.<key>` `` in a state's
instructions, on either visit, must be a key that a co-active state's `data` emits. Renaming a key fails the build
instead of leaving stale prose. The check runs `data` against the initial context with no event, so a key only an
effect's output supplies isn't there yet. It skips a state's `data` wherever a transition with an effect lands in it.

If a state spawns children, its instructions also have to say how they get driven, or the run hangs. See
[`subagents.md`](./subagents.md#driving-the-children).

## `data`

What the agent is shown while it is in this state. It's one of the two ways a value in context reaches an agent. The
other is a spawn's [`about`](./subagents.md#about), and the rest of context stays hidden
([ADR-0002](./adr/0002-context-hidden-except-declared-data.md)). It's how a value one driver sent reaches another.

```ts packages/backseat-ai/src/compiler/machine.ts
  data?: (args: { context: C; event?: E }) => unknown
```

```ts demos/one-value/one-value.ts
data: ({ context: { current, items } }) => ({ current, remaining: items.length }),
```

**How it prints.** An object prints as one field per key, in the order written, under `## Data`. Each field is a line
`- <key>: <type>` with the value under it. The type is the value's JavaScript kind (`string`, `number`, `boolean`,
`null`, `array` or `object`). A scalar is printed as text, and an array or object as a fenced JSON block. A key whose
value is `undefined` is left out. Anything other than an object prints as one fenced JSON block
([ADR-0013](./adr/0013-data-is-printed-as-labelled-fields.md)). So put prose the machine formatted under its own key and
it reads as prose.

**At most one active state may declare `data`.** The agent is shown one value. If two states that can be active
together both declare it, building the machine fails. That includes a parent and its child.

**`event` is there on one response only:** the one answering the send that delivered it. It carries the
[`output`](#effect) of that transition's effect and, where the transition collected children, `settled`. A rejection,
`snapshot`, `describe` and `create` pass no event. Nothing is kept for this, so whatever `data` shows from the event is
shown once:

```ts demos/one-value/effects.ts
data: ({ context, event }) => ({
  reads: context.reads.length,
  ...(event?.type === 'note.read' && { note: event.output }),
}),
```

## `schema`

The payload the agent must send: a zod object, or a function of context returning one.

```ts packages/backseat-ai/src/runtime/schema.ts
export type SchemaMeta<TContext = any> = AnyObjectSchema | ((context: TContext) => AnyObjectSchema)
```

This is exported as `Schema<C>`.

```ts demos/one-value/one-value.ts
schema: z.object({ items: z.array(z.string()).min(1) }),
```

On a **state**, it's the payload required to enter the state, from any transition that targets it. On a
**transition**, it's what that transition requires on top. The agent is shown the contract for each move: the target
state's schema extended with the transition's. A transition with no target carries its own schema alone. So put what's
always needed on the state, and what one event needs on that transition. A state schema that no transition an agent
can take ever targets fails the build, since no agent would ever be shown it.

A schema derived from context narrows the contract to the moment. This one accepts only the count the agent was shown:

```ts demos/one-value/one-value.ts
schema: ({ reports }) => z.object({ verdict: z.enum(['ok', 'redo']), count: z.literal(reports.length) }),
```

A derived schema takes context directly, where `data` takes `{ context, event }`. The agent is shown it again whenever
its rendered text changes.

**A field's `.describe()` reaches the agent.** It's printed as a comment after the field, ahead of the constraints
zod can state, which go in parentheses:

```text packages/backseat-ai/src/runtime/runtime.test.ts
url: string // the pull request to review (uri)
```

The payload is validated before any action runs, and a key the schema doesn't declare is dropped.

## `effect`

The tool call the transition exists to make: a read or a write the machine owns, made through a transition instead of
beside the machine. The refusals the agent already gets then cover it. A call in the wrong state is `not-enabled`, a
call with a bad payload is `invalid-payload` with the schema shown, and the trace is the call log
([ADR-0011](./adr/0011-a-transition-may-run-the-tool-it-guards.md)).

```ts packages/backseat-ai/src/compiler/machine.ts
export type Effect<C, Ev> = (args: { context: C; event: Sent<Ev> }) => Ev extends { output: infer O } ? O | Promise<O> : unknown
```

**`output` is declared on the event type**, and that's what types it. The transition's actions and the landing state's
`data` see it typed, the effect must return it, and a transition on that event with no effect fails to compile. A
guard and the effect itself see the event as the agent sent it, without `output`, because nothing has produced it yet.
An event type with no `output` may still carry an effect, for a write whose result nothing reads.

```ts demos/one-value/effects.ts
type Ev =
  | { type: 'note.read'; id: string; output: Note }
  | { type: 'note.write'; id: string; text: string; output: { written: string } }
  | { type: 'done' }
```

```ts demos/one-value/effects.ts
'note.read': {
  description: 'Read one note by its id.',
  schema: z.object({ id: z.string().min(1) }),
  effect: ({ event }) => {
    const text = shelf.notes.get(event.id)
    if (text === undefined) throw new RejectedEvent(`There is no note '${event.id}'; the shelf holds ${[...shelf.notes.keys()].join(', ')}.`)
    return { id: event.id, text }
  },
  // The machine keeps which notes were read, never what they said: the agent was shown that once.
  actions: assign({ reads: ({ context, event }) => [...context.reads, event.output.id] }),
},
```

It runs once the payload is valid and the transition is chosen, before XState sees the event, and it may be async. What
it returns rides the event as `event.output`. The actions decide what the machine keeps, and `data` decides what the
agent sees. A transition with an effect and nothing else is still a move: a read that only `data` shows needs no target
and no actions.

- **It may refuse.** Throwing [`RejectedEvent`](#rejectedevent) rejects the event as `refused`, with your message.
  Anything else it throws rejects it as `action-failed`. Either way the actor doesn't move.
- **Its writes aren't undone.** If an action after it refuses or throws, the transition is discarded and the write
  stays. The trace records the effect's output beside the rejection. So a transition that writes should do its refusing
  in the effect.
- **It belongs on an event an agent sends.** An effect on `always` is refused, because it would run with no call to
  run in, while the agent is away. `onDone` has no `effect` key.
- **Calls on one run take turns.** The CLI holds the run's lock for the whole call, so children driven in parallel
  wait for one another's effects.

`output` is the runtime's to write, so a schema written as a value that declares `output` fails the build. A schema
written as a function can't be read then, and whatever it accepts under `output` is overwritten by the effect's.

## `RejectedEvent`

```ts packages/backseat-ai/src/runtime/run.ts
/**
 * Thrown by an implementation to refuse the event it is running for. The runtime treats it as a rejected event —
 * nothing persists, the actor stays where it was, exit 2 — and hands the agent the message, which should say what
 * to do instead. Any other throw is an error: the actor errors and the run ends.
 */
export class RejectedEvent extends Error {
  override readonly name = 'RejectedEvent'
}
```

Throw it from an effect or an action to refuse the event, and say in the message what the agent should do instead
([ADR-0007](./adr/0007-an-action-may-refuse-the-event-it-runs-for.md)). It's matched by name, not `instanceof`, so a
machine whose code holds its own copy of the package still refuses correctly. An effect that throws anything else is
rejected as `action-failed` and the actor stays put. An action that throws anything else errors the actor, unless the
transition collects children (see [`subagents.md`](./subagents.md#collectchildren)).

**Refuse in `effect`**, which runs before any action. An action's refusal comes mid-transition, after the source
state's exit actions and whatever came before it in its list, and building the machine can't tell a refusing action
from any other. The actor is restored, but a write outside the machine isn't, so an action that must refuse touches
nothing outside the machine.

## `withCheckInput`

`context` is XState's, as a value or as a function of `{ input }`. Building the machine runs the function once, to make
the initial snapshot that the `data` checks run against. It has no real input then, so it's handed `{}`, which is
enough unless the initializer uses what it's handed. For one that does, wrap it in `withCheckInput` with the smallest
input that lets it run:

```ts demos/one-value/one-value.ts
const { createMachine: createWorker, withCheckInput } = backseat<WorkerContext, WorkerEvent, { item: string }>()
```

```ts demos/one-value/one-value.ts
  context: withCheckInput(({ input }) => ({ item: input.item, note: null }), { item: 'sample' }),
```

The sample is only used for that snapshot and never reaches a run. It's typed as `Input`, so a sample that drifts from
the real input shape fails to compile. When an initializer without a sample fails, the error tells you to use
`withCheckInput`. What comes back is still a plain function of `{ input }`.

## `transition`

A transition written in a `const` outside the machine has no contextual type. Its actions see XState's `AnyEventObject`,
and where you use it the error is a long type dump that never names a mistake. To write one once and use it in several
states, pass it through `transition`, naming the event it's for:

```ts demos/one-value/hoisted.ts
const { createMachine, transition } = backseat<Ctx, Ev>()

// Written for `bump`, so `event.by` is typed here. Its target is checked where it is used.
const bump = transition('bump')({
  target: 'counting',
  description: 'The count goes up.',
  actions: assign({ count: ({ context, event }) => context.count + event.by }),
})
```

```ts demos/one-value/hoisted.ts
      on: { bump, rest: { target: 'resting', description: 'A rest.' }, finish: { target: 'done', description: 'The count is done.' } },
```

An event the machine doesn't declare, a misspelled key, and a payload field the event doesn't carry are named on the
line that writes the transition. A target that isn't a sibling, and the transition used under an event it wasn't
written for, are caught where it's used, but the line that names the mistake comes last, under a long type dump. It's
for `on` only. `always` and `onDone` aren't events an agent sends, so write those inside the machine.

What comes back is the object you wrote, so a state that needs it slightly different spreads it and adds what's
different, such as `{ ...bump, schema }`. The result is checked where it's used, like any transition written in place.

## Reserved names

**Seven `meta` keys.** `meta` is yours, as in XState, on a state, the root and a transition, and `getMeta()` reads it
back. Backseat writes its own keys into `meta` beside yours, and the runtime obeys them, so these seven are refused
under `meta`, each telling you where it's written instead:

```ts packages/backseat-ai/src/compiler/machine.ts
const reservedMeta: { [K in keyof Required<AgentMeta>]: string } = {
  instructions: 'write it beside meta, not under it',
  data: 'write it beside meta, not under it',
  schema: 'write it beside meta, not under it',
  effect: 'write it beside meta, on the transition, not under it',
  sites: 'a site is read off the spawnChild actions a state runs',
  settled: 'a transition is gated by collectChildren in its actions',
  sampleInput: 'pass it to withCheckInput with the context initializer',
}
```

**Two event keys.** The runtime puts `output` on the event of a transition with an effect, and `settled` on the event
of one that collects children. Both are added after the payload is validated, which has already dropped any key the
schema doesn't declare, so an agent can't supply either.

**Event names.** An `on` key must be an event an agent can send. `xstate.done.actor.*`, `xstate.error.actor.*`,
`agent.*` and any wildcard are refused ([`xstate.md`](./xstate.md#refused)). `agent.` belongs to the runtime.

The runtime also accepts machines written in plain XState, which never pass through this surface. For those, building
the runtime repeats the checks on `on` keys, effect placement, `output` in a schema and spawn sites. It doesn't repeat
the compile-time ones.
