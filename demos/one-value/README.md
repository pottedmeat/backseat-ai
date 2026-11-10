# one-value

A machine as **one TypeScript value**, handed to Backseat's own `createMachine`. A fixture, not a demo: it
proves the surface compiles from a consumer package under `nodenext` + `skipLibCheck`,
and `packages/backseat-ai/src/compiler/machine.test.ts` drives it through the runtime and pins the
error an author sees for each mistake it can make.

`one-value.ts` holds two machines: a spawn-only `worker`, and a `lead` that dispatches
one worker per item, gates its review on every worker having settled, and reads a
context-derived schema. Each spawn also carries an `about`: the lead's own note on that
one worker, saying a thing the worker is never told. `machines.ts` is the catalog,
naming the lead as `one-value`.

Three more fixtures sit beside it, authoring-only and outside the catalog. `doors.ts` holds
every place a `target` can be written. `effects.ts` holds a `reader` that owns its tool:
a read and a write of an exported `shelf`, each a transition with an `effect`, whose
`output` the actions and `data` read off the event
([ADR-0011](../../docs/adr/0011-a-transition-may-run-the-tool-it-guards.md)). `hoisted.ts` writes one
transition outside the machine with `transition()` and uses it in two states.
