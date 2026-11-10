# A machine is one TypeScript value, a superset of XState's config

Backseat makes first-class things an XState config has no home for: the instructions and data an agent reads, the payload schema it must satisfy, the effect a transition runs, and where children are spawned and collected. Written into a plain XState config, they would be smuggled into `meta` with nothing to check them.

**A machine is one TypeScript value handed to Backseat's `createMachine`, which lowers it into XState's in the call: `backseat<Context, Event, Input>().createMachine(value)`. Its type is a superset of XState's config, with `instructions`, `data` and `schema` first-class on a state or transition, and building it is verifying it.** There is no separate file, no compile step and no check command. A machine is registered by being written into the catalog the project's `cli.ts` names, and a machine that builds is a machine that registers.

Because the surface is its own type rather than XState's, it can do what XState's does not: it checks a target against the states the author wrote and refuses a key that is not XState's or Backseat's. `createMachine` then runs every check registration needs, the spawn sites against the `actors` roster, the root description, the initial snapshot, the `data` projections and the keys the instructions name, so importing a module of machines is the whole of checking them and there is no pass to forget. Spawning stays XState's own: `spawnChild` is XState's, returned typed by `backseat()`, and `collectChildren` marks the transition that gathers what was spawned.

`meta` stays the author's. A library other people build on cannot take XState's annotation slot away from them, so an author's `meta` on a state, the root or a transition is carried through, with lowering's keys merged in beside it. The keys the runtime reads there (`instructions`, `data`, `schema`, `effect`, `sites`, `settled`, `sampleInput`) are refused when the machine is built, because each written by hand would be obeyed without what produces it. A sample input for building the initial snapshot is written by wrapping the context initializer, `context: withCheckInput(initializer, sample)`, so it sits beside the one thing that reads it and `context` stays XState's own function form; when an initializer with no sample cannot run on `{}`, the error says to wrap it.

## Considered options

- **Declaration merging into XState's types.** Rejected: it is program-wide and cannot be scoped to the machines that want it.
- **A data file paired with an implementations module.** Rejected: it needs a compile step, a reference resolver and a check that someone can forget to run, all to describe what a TypeScript value states directly.

## Consequences

Two calls where one would read better, because TypeScript cannot infer the value's type while the context and event types are supplied. And no interchange with Stately Studio as an authoring format; the export is a view ([ADR-0010](0010-the-stately-export-is-a-view.md)).
