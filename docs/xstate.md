# The XState a Backseat machine is written in

A Backseat machine is an XState v5 machine. You write it with XState's own keys, the XState way, and Backseat adds a few
keys of its own and narrows a few of XState's. This page lists what to read on [stately.ai](https://stately.ai/docs)
before writing one, then what Backseat changes. Everything Backseat adds is covered in [`machines.md`](./machines.md)
and [`subagents.md`](./subagents.md).

The links go to Stately's unversioned pages, which document v5. Backseat needs `xstate` `^5.32.6`. The pages under
`/docs/xstate/v6/` document the v6 alpha, which Backseat doesn't support.

## What to read

### Every machine uses these

1. **State machines and statecharts.** [state-machines-and-statecharts](https://stately.ai/docs/state-machines-and-statecharts)
   is the best first read: states, events and transitions, then final and parent states.
2. **Actors.** An actor is a running instance of a machine, and an agent drives one actor at a time:
   [actors](https://stately.ai/docs/actors). [actor-model](https://stately.ai/docs/actor-model) gives the background.
3. **A machine as a config object.** [machines](https://stately.ai/docs/machines#creating-a-state-machine). In Backseat
   the whole machine is that one object.
4. **States, with `description` and `meta`.** [finite-states](https://stately.ai/docs/finite-states),
   [`meta`](https://stately.ai/docs/finite-states#meta), [state descriptions](https://stately.ai/docs/states#state-descriptions).
   An agent reads a state's `description` while it decides whether to go there.
5. **The initial state.** [initial-states](https://stately.ai/docs/initial-states).
6. **Events and transitions.** [transitions](https://stately.ai/docs/transitions),
   [event objects](https://stately.ai/docs/transitions#event-objects),
   [transition descriptions](https://stately.ai/docs/transitions#transition-descriptions). Every key under `on` is an
   event an agent sends.
7. **Self-transitions and `reenter`.** [self-transitions](https://stately.ai/docs/transitions#self-transitions),
   [re-entering](https://stately.ai/docs/transitions#re-entering). A state that re-enters itself runs its entry actions
   again, which is how a machine spawns one more child per round.
8. **Final states.** [final-states](https://stately.ai/docs/final-states).
9. **Context and `assign`.** [context](https://stately.ai/docs/context),
   [updating context with `assign`](https://stately.ai/docs/context#updating-context-with-assign),
   [the `assign` action](https://stately.ai/docs/actions#assign-action). Context is what persists between calls, and an
   agent sees none of it unless a state shows it.
10. **Actions, on entry and on a transition.** [entry and exit actions](https://stately.ai/docs/actions#entry-and-exit-actions),
    [inline actions](https://stately.ai/docs/actions#inline-actions).
11. **Guards, and the first one that passes wins.** [inline guards](https://stately.ai/docs/guards#inline-guards),
    [multiple guarded transitions](https://stately.ai/docs/guards#multiple-guarded-transitions). An agent is offered a
    move only while its guard passes.

### Machines that hand work to subagents use these

12. **Input, and `context` as a function of it.** [input](https://stately.ai/docs/input),
    [lazy initial context](https://stately.ai/docs/context#lazy-initial-context). A spawned child gets its context this way.
13. **A machine's `output`.** [output in machine actors](https://stately.ai/docs/output#output-in-machine-actors),
    [final-state output](https://stately.ai/docs/final-states#output). A child's output is what its parent collects.
14. **Spawning a child with `spawnChild`.** [spawn](https://stately.ai/docs/spawn),
    [spawning options](https://stately.ai/docs/spawn#spawning-options). Most of that page's examples pass the child's logic
    to `spawnChild` directly, which Backseat refuses. Pass a name from the machine's `actors` instead, as the page's
    cheatsheet does. The spawn example on [input](https://stately.ai/docs/input#spawning-actors-with-input) uses `spawn`
    inside `assign`, which is a different action.

### Machines that group states use these

15. **Parent states, `onDone`, and eventless `always`.** [parent-states](https://stately.ai/docs/parent-states),
    [child final states](https://stately.ai/docs/final-states#child-final-states),
    [eventless-transitions](https://stately.ai/docs/eventless-transitions). A parent state is left when its region
    reaches a final child.
16. **Persistence and restore.** [persistence](https://stately.ai/docs/persistence),
    [restoring state](https://stately.ai/docs/persistence#restoring-state). You never call these yourself, but every call
    an agent makes restores the actor from disk, runs, and persists it again. That's the reason for most of what
    Backseat refuses below.

[History states](https://stately.ai/docs/history-states) are allowed, under the target rule below, but no shipped
workflow uses one.

## What Backseat changes

Backseat's `createMachine` takes XState's config with some keys narrowed or refused. Each one is a compile error at
the key you wrote, and most of the type names explain the error. Most of the narrowing comes from one rule: an agent
reads the machine one state at a time, and the actor must never move while the agent is away
([ADR-0008](./adr/0008-an-actor-never-changes-under-its-driver.md)).

### Refused

- **`after`.** Each call is its own process ([ADR-0003](./adr/0003-cli-rehydrates-per-invocation.md)), so there's no
  process left running for a timer to fire in. XState doesn't persist a pending delay either. A delay firing between
  calls would also make the last response the agent read untrue. The type is `NoTimerFiresBetweenInvocations<'after'>`.
- **`invoke`.** A restored actor runs its invoked actors again on every restore, and an invoked actor that finishes
  moves its parent while the agent is away. The type is `SpawnAndCollectRatherThanInvoke<'invoke'>`. Use a transition's
  `effect` for a tool call: it runs inside the call that sends the event, and its result arrives as `event.output`
  ([`machines.md`](./machines.md#effect)). For work handed to another agent, spawn a child and collect it
  ([`subagents.md`](./subagents.md)).
- **`on` keys no agent can send.** These are `xstate.done.actor.*`, `xstate.error.actor.*`, anything starting with
  `agent.`, and a wildcard like `*` or `review.*`. All four are refused as `NotAnEventAnAgentCanSend`. A child finishing
  is acted on by collecting it.
- **`on` keys outside the machine's own event type.** XState accepts these. Backseat refuses them as
  `NotAnEventThisMachineDeclares`, because a misspelled event would never be sent.
- **Keys neither XState nor Backseat defines.** A misspelled key is refused by name, on a state as
  `NotAKeyOfABackseatState` and on a transition as `NotAKeyOfABackseatTransition`.
- **`syncSnapshot` on `spawnChild`.** It's left out of the options type.

### Narrowed

- **A `target` names one sibling.** XState's `target` can be an id, a dotted path, a child, or an array of those. In
  Backseat it's one name from the siblings of the state the transition is written on. A state's own name counts, so a
  self-transition works. A misspelled target fails to compile, with the list of names it could be. The rule holds
  everywhere a target is written:
  - on `on` and `always`, it names a sibling of the state the transition leaves;
  - on `onDone`, it names a sibling of the parent state whose region finished;
  - a history state's `target` names a sibling of that history state.

  The root has no siblings, so a transition on the root's `on` takes no target. It's offered from every state and can
  run actions, but it doesn't move the actor. To move the machine, write the transition on the state it leaves.
- **A transition is an object.** XState's shorthand `on: { next: 'reviewing' }` is refused: write
  `on: { next: { target: 'reviewing' } }`. An array is a contest of objects, tried in the order written.
- **Actions, guards and delays are values.** Pass the function itself, not a name. There's no `setup()`: the action,
  guard and delay names are typed `never`, so a string where an action goes fails to compile.
- **Types are type arguments.** Instead of a `types` key, write `backseat<Context, Event, Input>()`
  ([`machines.md`](./machines.md#backseat-and-createmachine)).
- **`actors` is on the machine value, and holds machines.** It's the list of machines this one spawns, under the names
  `spawnChild` uses.
- **`spawnChild` takes a name from `actors`.** Never logic. A child spawned from inline logic can't be persisted, so
  it couldn't be restored on the next call. A name that isn't in `actors`, or an entry in `actors` that nothing spawns,
  throws when the machine is built.
- **`onDone` takes no `schema`, no `instructions` and no `collectChildren`.** No agent chooses an `onDone` transition,
  so none of those would ever be read. XState's other transition keys are allowed.
- **`initial` in its object form takes `target` and `actions`, nothing else.** XState ignores any other key on an
  initial transition, so Backseat refuses them instead of dropping them.
- **`meta` is yours, except for seven keys.** Backseat writes its own keys into `meta` when it builds the machine, so
  those seven are refused under `meta` ([`machines.md`](./machines.md#reserved-names)).
- **The root needs an `id`, a `description` and a `context`.** XState lets you leave them out.

Backseat also adds a slice of its own to `context` and a transition of its own to the root, for tracking what the
agent has been shown. Neither appears in your `Context` or `Event` types.
