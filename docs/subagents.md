# Handing work to subagents

When the work is bigger than one agent, a machine **spawns child machines** and **collects** them at the transition
that needs their results. Each child is its own actor, driven by its own subagent. This page covers what you write for
that: the roster, the spawn, and the collection. The rest of a machine is in [`machines.md`](./machines.md).

```ts demos/one-value/one-value.ts
import { backseat, collectChildren } from 'backseat-ai'
```

## The roster: `actors`

`actors` sits on the machine value, not in `setup()`. It lists the machines this one spawns, under the names
`spawnChild` uses:

```ts demos/one-value/one-value.ts
  actors: { worker },
```

A child is always spawned by a **name** from this roster, never from a machine value passed inline. The name is the
only thing about a child that survives persistence, and every call restores the actor from disk. A child spawned from
inline logic couldn't be restored. `createMachine` throws on a name the roster doesn't hold, listing the names it does,
and on a roster entry that nothing spawns.

A child machine doesn't need to be in the project's catalog. Being reached only by a spawn is what keeps it out.

## `spawnChild`

Spawn with the `spawnChild` that `backseat()` returns alongside `createMachine`. It's XState's own `spawnChild`,
returning XState's action, with three differences:

- **The `id` and `input` callbacks are typed.** At a bare call site, XState's `spawnChild` leaves `context` an implicit
  `any`. This one is handed `{ context, event }` already typed.
- **It takes [`about`](#about).** XState's `spawnChild` drops an option it doesn't know.
- **`id` is required.** `createMachine` refuses XState's own `spawnChild` without one too. See [Child ids](#child-ids).

```ts packages/backseat-ai/src/compiler/machine.ts
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
```

`input` becomes the child's context, so it's an object or a function returning one, and a bare string fails to compile.

```ts demos/one-value/one-value.ts
entry: spawnWorker('worker', {
  id: ({ context }) => `w-${context.current}`,
  input: ({ context }) => ({ item: context.current ?? '' }),
  about: ({ context }) => `item "${context.current}", ${context.items.length} still queued`,
}),
```

A state that spawns one child per round re-enters itself, which runs its entry actions again:

```ts demos/one-value/one-value.ts
{ guard: itemsLeft, target: 'dispatching', reenter: true, description: 'Another item is waiting.', actions: assign(pullNext) },
```

### Child ids

A child's id is qualified by its parent's: `<parent id>/<key>`, where the key is the `id` you gave `spawnChild`. That's
the id a subagent drives the child by, the id a pending child is named by, and the `actorId` it's collected under. Take
the last segment to get your key back.

A key must be unique among the children a parent holds at once. XState files a child under its key and replaces
whatever the key held without stopping it, which would leave that child running with nothing to collect it. So a call
whose spawn would do that is rejected as `action-failed` and nothing it did is kept, and a first state that spawns two
children under one key fails `create`. Collecting a child frees its key: a fixed id is fine on a state that collects
its children before re-entering, and a state re-entered while they still run needs an id from context, as above.

## Spawn sites

A **spawn site** is a state plus one machine it spawns. You don't declare one. Write `spawnChild` in any action list a
state runs (on entry, in its `initial`, or on a transition it owns), and `createMachine` reads the site back off the
action.

Every site must be collected by some transition. A site nothing collects throws from `createMachine`, because its
children's results would be thrown away. A transition that could reach two sites of the same machine also throws,
since a child couldn't be filed under either.

## `about`

The parent's own note on **this** child: what this one worker was handed. A state's [`data`](./machines.md#data) can't
say that, because it can't tell two children apart.

```ts packages/backseat-ai/src/compiler/machine.ts
  about?: Record<string, unknown> | ((args: SpawnArgs<C, E>) => unknown)
```

Like `input`, it's an object or a function returning one, so `about: 'the sub-question'` fails to compile. The function
form is how a note becomes a string.

- **It never reaches the child.** `input` is what the child gets.
- **The parent is told it once**, on the call that spawns. After that, the parent holds the child's id and can ask the
  child, which answers from its own `data`.
- **It's kept** on the run record and carried into the collection, so a child that broke still says what it was for.
  That's the one case where there's nothing left to ask.
- **Without it**, the child is announced with the `input` it was given. That works for a plain XState `spawnChild` too.
- **It's resolved at the spawn**, not later. Spawns are entry actions, and any `assign` after them in the same list has
  already moved context on by the time the call ends. A note resolved then would describe the next child's work.

## Driving the children

The response to a call that spawns lists each child under `## Subagents to start`. Each entry has the child's id, its
`about`, and the first command its subagent runs:

```text demos/deep-research/recorded/1/calls/004.txt
## Subagents to start

- 1b36b700-73f1-4497-80fd-993bb42a624f/task-1-1 — Which Branson-area fishing spots are free or low-cost, with fishing docks, piers or bank access suitable for young children (e.g., Table Rock State Park dock, Moonshine Beach, Branson Landing)? Cover only access, safety and cost, not guided trips.
  `node cli.ts --drive snapshot 1b36b700-73f1-4497-80fd-993bb42a624f/task-1-1`
```

That's all the runtime says about them. It lists the children but never says they must be started. **The spawning
state's [`instructions`](./machines.md#instructions) have to say it:** start a subagent for each child listed, give it
the command listed for it, and wait until they're all done.

A machine that spawns without saying so hangs. The children are created but never driven, so they never settle, and
the transition that would collect them is refused forever. Pairing every `spawnChild` with a `collectChildren` doesn't
prevent this. A machine can pair them correctly, build cleanly, and still hang.

## `collectChildren`

An action on a transition. It holds the transition back until every child spawned at one site has settled, then hands
the transition's actions what they returned.

```ts packages/backseat-ai/src/compiler/machine.ts
export function collectChildren<C extends MachineContext, Ev extends EventObject, E extends EventObject>(state: string, machine: string, ...actions: Array<Action<C, Settled<Ev>, E>>): Collect<C, Ev, E> {
```

A child is **settled** once it's no longer among its parent's children: finished, failed or stopped. A child still
running is **pending**.

```ts demos/one-value/one-value.ts
actions: collectChildren('dispatching', 'worker', assign({ reports: ({ event }) => event.settled.flatMap((site) => site.children.map((child) => child.output)) })),
```

Name both halves of the site: the state the children were spawned at, and the machine they are. The state is what
tells one round's children from another's, and it isn't always the state the transition leaves. Write one call per
site, so a transition can wait on several.

It goes in a transition's `actions`, under `on` or `always`. It's refused on `onDone`, which no agent chooses.

**Before it can be taken**, the transition isn't offered. A move that isn't available yet isn't shown
([ADR-0008](./adr/0008-an-actor-never-changes-under-its-driver.md)). If the agent sends it anyway while any child is
pending, it's rejected as `pending-children`, naming every pending child by the id the agent drives it by. A `describe`
of it is refused the same way. Nothing waits and nothing is pushed: the agent lets its children finish, and the next
response offers the transition. Until then, a response offering no move says only that one is waiting on subagents,
not which. So the state's instructions should say what the move is and that it comes once the children are back.

**Taking it collects** the site. The actions you pass get the collection on the event:

```ts packages/backseat-ai/src/compiler/machine.ts
export type Settled<E> = E & { settled: Collection[] }
```

```ts packages/backseat-ai/src/runtime/registry.ts
export type CollectedChild = { actorId: string; status: 'done' | 'error' | 'stopped'; output?: unknown; error?: string; about?: unknown }
/** What one `settled` entry hands its actions: the site, and every child that settled there. */
export type Collection = { state: string; src: string; children: CollectedChild[] }
```

`Settled`, `Collection` and `CollectedChild` are all exported from `backseat-ai`. Inside a collected action, `event` is
already `Settled` of the transition's own event, so `event.settled` is typed down to `status`. `output` and `about` are
`unknown`, so you narrow them yourself. `error` is the message of a child that crashed, which is collected with
`status: 'error'` instead of taking its parent down.

What `collectChildren` returns is a `Collect`, a marker `createMachine` replaces with the actions it wraps:

```ts packages/backseat-ai/src/compiler/machine.ts
export type Collect<C extends MachineContext, Ev extends EventObject, E extends EventObject> = {
  readonly [COLLECT]: [C, Ev, E]
}
```

- **Any action may be passed**, not only `assign`. The wrapped actions run where the `collectChildren` call sits in the
  transition's action list, and the collected children are stopped after every action. Copy out what you need: once a
  child is stopped, the collection is the only place its output appears.
- **One event reaches the whole transition**, so an action outside `collectChildren` still receives `settled` at run
  time. Only the types keep it off. Read it from a collected action, where it's typed.
- **A throw in a collected action costs the round, not the run.** The transition is discarded, everything the
  collection wrote is thrown away, and the children aren't stopped. The event is rejected as `action-failed` with the
  thrown message, the actor stays where it was, and the same event can be sent again. So put `assign` first and any I/O
  after it, so a failure costs the write and not the move.
- **Collecting doesn't clear a site.** Two transitions waiting on one site both see its children. The next spawn there
  clears it, which keeps one round's children out of the next round's collection.

## Waiting for children

`invoke` is refused, and so are `on` keys for `xstate.done.actor.*` and `xstate.error.actor.*`
([`xstate.md`](./xstate.md#refused)). Each would move the parent while its driver is away. A collecting transition is
the one way to act on a child finishing. It isn't offered while any child is running, sending it is refused by name,
and once it is offered, taking it hands over everything that settled.
