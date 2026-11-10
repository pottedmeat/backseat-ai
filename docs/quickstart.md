# Starting a project

A Backseat project is a directory with a `package.json`, a `cli.ts` and a catalog of machines. `npx backseat-ai init`
writes all of it, installs the dependencies, and can write a starter machine to drive. This page runs `init` in an
empty directory, shows each file it writes, and drives the starter to the end. The XState a machine is written in is
in [`xstate.md`](./xstate.md), and writing your own machine is in [`machines.md`](./machines.md).

Everything below is one continuous session, recorded in `docs/captures/quickstart.txt` from the published package
in an empty directory named `my-agent`, with npm's own output cut to `…`.

## `init`

Run it in the directory that should become the project. `--starter` writes a starter machine:

```text docs/captures/quickstart.txt
$ npx backseat-ai init --starter
# started 2026-11-10T17:57:29Z, exit 0

…
created   package.json — my-agent
updated   scripts.typecheck — tsc
$ npm install backseat-ai@^0.1.0 xstate@^5.32.6 zod@^4.5.4
…
updated   dependencies — backseat-ai xstate zod
$ npm install -D typescript@^7.0.2 typescript5@npm:typescript@^5.9.3 @types/node@^26.4.1
…
updated   devDependencies — typescript typescript5 @types/node
created   tsconfig.json
created   cli.ts
created   my-agent.ts — the smallest machine: one move, then finished
created   machines.ts — registers my-agent
ok        node cli.ts --drive — fronts my-agent

Set up. Start a machine with `node cli.ts --drive create <machine>`; lint with `node cli.ts lint`.
```

Each line is one thing `init` checked, and the word in front says what it did:

```ts packages/backseat-ai/src/cli/setup.ts
type Outcome = 'created' | 'updated' | 'ok' | 'conflict' | 'skipped' | 'failed' | 'note'
```

- **The name.** `init [<name>]` takes the project's name, which defaults to the directory's. A new `package.json` gets
  it, and so does one with no `name`. On a terminal with no name given, `init` asks for one before it creates the
  `package.json`.
- **The package manager.** It's the one the project is already under, found by a lockfile here or in a directory
  above, then the one that ran `init`, then npm. `npx` is npm, so this capture used npm. Each install command is
  printed as a `$` line before it runs, and the manager's own output follows. `--no-install` writes the dependencies
  into `package.json` and skips the install.
- **The machine.** With no machine in the directory, `--starter` writes one and `--empty` writes an empty catalog. On a
  terminal, `init` asks which. Without a terminal and without either flag, it writes no catalog.
- **The gate.** Last, once nothing is left in conflict, `init` runs the project's own `node cli.ts --drive`, which
  imports the catalog and so builds every machine in it. `ok` lists the machines it fronts. A machine that fails to
  build makes this line `failed`.

`init` replaces nothing you wrote without a yes. A `package.json` with the wrong `type`, a `tsconfig.json` missing a
setting a machine needs, or a `cli.ts` that doesn't name the catalog is a `conflict`. On a terminal each one is asked
about, and `--yes` accepts every fix. A conflict left standing is listed with its fix, and `init` exits 1. Running
it again finishes whatever is missing and says `ok` to the rest. `backseat-ai setup` is the same command, by the name
for afterwards.

## The files it writes

### `package.json`

A `name`, `"type": "module"` (and `"private": true` on one it creates), a `typecheck` script running `tsc`, and the
dependencies: `backseat-ai`, `xstate` and `zod`, then `typescript`, `typescript5` and `@types/node` for development.
`typescript5` is TypeScript 5 under another name. [`stately`](./stately.md) reads its compiler API, which TypeScript 7
doesn't have. Every run records the project by its `name` ([`runs.md`](./runs.md)).

### `tsconfig.json`

Strict, with no emit: Node runs the `.ts` files directly. A machine file needs four settings, and `init` checks for
them in a `tsconfig.json` that's already there:

```ts packages/backseat-ai/src/cli/setup.ts
const TS_REQUIRED = { module: 'nodenext', moduleResolution: 'nodenext', allowImportingTsExtensions: true, noEmit: true }
```

They let a machine import its siblings by their `.ts` names. A `tsconfig.json` that `extends` another, or isn't plain
JSON, is never rewritten. `init` says `skipped` and names the four settings to check by hand.

### `cli.ts`

The project's front for its machines. An agent runs it as `node cli.ts --drive`, and a person runs it as `node cli.ts`:

```ts docs/captures/quickstart.txt
// This project's front for its machines: `node cli.ts --drive` is the agent's tool, `node cli.ts` a person's.
// The catalog is named here and never imported, so a run can pin it before anything loads it.
import { cli } from 'backseat-ai/cli'

await cli(new URL('./machines.ts', import.meta.url))
```

It names the catalog by URL and never imports it. A `cli.ts` that imports the catalog is a `conflict`, because a run
couldn't pin the catalog before it loads ([`runs.md`](./runs.md)).

### `machines.ts`

The catalog: every machine an agent may `create`, under the name it creates it by.

```ts docs/captures/quickstart.txt
import { myAgent } from './my-agent.ts'

/** Every machine an agent may `create`, under the name it creates it by. A machine only ever spawned stays out. */
export default {
  'my-agent': myAgent,
}
```

When machines already exist, `init` finds them by reading their source, never by importing it, and registers each
under its name in kebab case. Reading source is a heuristic, which is why the `created` line lists what it
registered. A machine another machine lists in its `actors` is left out with a `note`, since it's only ever spawned
([`subagents.md`](./subagents.md)). An existing catalog is never rewritten. A machine it doesn't register gets a
`note`.

### The starter machine

Named after the project, with one move and then a final state:

```ts docs/captures/quickstart.txt
import { backseat } from 'backseat-ai'

export const myAgent = backseat().createMachine({
  id: 'my-agent',
  description: 'TODO: what my-agent is for.',
  context: {},
  initial: 'start',
  states: {
    start: {
      description: 'The beginning.',
      instructions: 'Do the work this machine is for, then finish.',
      on: { go: { target: 'done', description: 'Finish.' } },
    },
    done: { type: 'final', description: 'Finished.', instructions: 'Tell whoever asked for this what was done. The run ends here.' },
  },
})
```

Every key in it is covered in [`machines.md`](./machines.md).

## Driving the starter

An agent drives a machine through `node cli.ts --drive`, one call at a time. Tell it to run `create`:

```text docs/captures/quickstart.txt
$ node cli.ts --drive create my-agent
# started 2026-11-10T17:57:32Z, exit 0

Actor `8b28f092-25ed-4448-9b4f-497bd053ff98` is running `my-agent`.

Do the work this machine is for, then finish.

## To move to state: done (Finished.)

### go → done (Finish.)

    no payload
```

The first line names the actor, and only `create` prints it. Then come the instructions of the state it's in, and the
moves it can make, grouped under the state each one leads to. The text in parentheses is the `description` of that
state, then of the transition. `go` takes no payload.

Below that, on an actor's first response only, is `## How to drive this tool`, a paragraph teaching the agent how to
read and answer these responses. Every response ends with a footer naming the actor, where it is, and whether it's
still running:

```text docs/captures/quickstart.txt
---
8b28f092-25ed-4448-9b4f-497bd053ff98 · at start · active
```

The agent sends the one move it was offered:

```text docs/captures/quickstart.txt
$ node cli.ts --drive send 8b28f092-25ed-4448-9b4f-497bd053ff98 go
# started 2026-11-10T17:57:32Z, exit 0

Tell whoever asked for this what was done. The run ends here.

This actor is done. Nothing more can be sent.

---
8b28f092-25ed-4448-9b4f-497bd053ff98 · at done · done
```

A final state's instructions lead its response, since they were written for this moment, and the actor says it's
done. Nothing was written into the project: the actor lives in its run, outside it ([`runs.md`](./runs.md)).

## Next

For a coding agent that writes or debugs machines in this project, `npx skills add pottedmeat/backseat-ai --skill
backseat-ai` installs a companion skill. It routes the agent to these docs, as installed with the package.

- [`machines.md`](./machines.md): replacing the starter with a machine of your own.
- [`subagents.md`](./subagents.md): a machine that hands work to subagents.
- [`driving.md`](./driving.md): every response a driver sees, and how a refusal reads.
- [`runs.md`](./runs.md): where a run lives, and the commands that read it.
- [`style.md`](./style.md): writing a machine an agent drives well.
- [`cli.md`](./cli.md): every command and flag.
- [`stately.md`](./stately.md): viewing a machine in Stately Studio.
