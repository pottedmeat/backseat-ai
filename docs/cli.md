# Commands

Backseat has three groups of commands. Which group a command is in follows from what it reads:

| Run as | For | Reads |
| --- | --- | --- |
| `npx backseat-ai <command>` | People, from anywhere | No catalog: it sets a project up, or reads the run store |
| `node cli.ts <command>` | People, from inside a project | The catalog the project's `cli.ts` names |
| `node cli.ts --drive <command>` | The agent driving a machine | The catalog, and the run of the actor it names |

What reads a catalog runs through the project's own `cli.ts`, so the copy of Backseat that drives, lints and draws a
project's machines is always the one that built them
([ADR-0012](./adr/0012-the-project-cli-names-the-catalog.md)). The `backseat-ai` bin holds only what reads no catalog,
so any copy of it does the same thing.

This page lists every command and flag. The pages linked from each say what it does in full.

## `backseat-ai`

The one bin the package installs. Run it with `npx backseat-ai`, or install it once with `npm install -g backseat-ai`.
With no command, or `help`, `--help` or `-h`, it prints its commands. `--version` or `-v` prints the version.

```ts packages/backseat-ai/src/cli/human.ts
export const commands: Record<string, Command> = {
  output: {
    description: 'Print a finished actor’s output: `output <actorId>`, the root id or a prefix of it, a child as `<root>/<key>`.',
    run: output,
  },
  report: {
    description: 'List every run the tool can find and render one as a trace report: `report [<root id prefix> | <dir>] [--no-open]`.',
    flags: ['--no-open'],
    run: report,
  },
  init: {
    description: 'Set the working directory up as a project — package.json, dependencies, tsconfig.json, cli.ts and a catalog — finishing whatever is missing: `init [<name>] [--yes] [--starter | --empty] [--no-install]`.',
    flags: SETUP_FLAGS,
    run: async (args) => (await import('./setup.js')).setup(args),
  },
  setup: {
    description: 'The same as `init`, by the name for afterwards: finish or repair a project, any time. It leaves what is right alone, and replaces nothing without a yes.',
    flags: SETUP_FLAGS,
    run: async (args) => (await import('./setup.js')).setup(args),
  },
  doctor: {
    description: `Propose removing live runs untouched for ${STALE_DAYS} days, and run-less calls as old; \`doctor --yes\` removes them.`,
    flags: ['--yes'],
    run: doctor,
  },
}
```

| Command | Flags | Details |
| --- | --- | --- |
| `init [<name>]` | `--yes` accepts every fix to a conflict. `--starter` writes a starter machine and `--empty` an empty catalog, when there's no machine yet. `--no-install` writes the dependencies into `package.json` without installing them. | [`quickstart.md`](./quickstart.md#init) |
| `setup` | The same as `init`. | [`quickstart.md`](./quickstart.md#init) |
| `output <actorId>` | None. | [`runs.md`](./runs.md#output) |
| `report [<root id prefix> \| <dir>]` | `--no-open` writes the page without opening it. | [`runs.md`](./runs.md#report) |
| `doctor` | `--yes` removes what it proposes without asking. | [`runs.md`](./runs.md#doctor) |

## `node cli.ts`

A project's `cli.ts` without `--drive`. These are a person's commands, and they read the project's catalog. With no
command, or `help`, `--help` or `-h`, it prints them. `--version` or `-v` prints the version of the Backseat the
project has installed.

```ts packages/backseat-ai/src/cli/human.ts
export const projectCommands: Record<string, ProjectCommand> = {
  lint: {
    description: 'Report the style facts a walk over each built machine can establish: `lint [<machine>...]`.',
    run: lint,
  },
  stately: {
    description: 'Write each catalog machine, and the machines it spawns, as a file to import into Stately Studio: `stately [<machine>...] [--out <dir>]`.',
    flags: ['--out'],
    run: stately,
  },
}
```

| Command | Flags | Details |
| --- | --- | --- |
| `lint [<machine>...]` | None. | [`style.md`](./style.md) |
| `stately [<machine>...]` | `--out <dir>` writes the files there, not into the current directory. | [`stately.md`](./stately.md) |

Neither group ignores a flag it doesn't know. A mistyped `--yse` must not run `init` without its yes, so any argument
starting with `-` that the command doesn't take is an error.

## `node cli.ts --drive`

The agent's tool. It's driven by an agent, never by a person typing at it
([ADR-0001](./adr/0001-cli-targets-agents-not-humans.md)), and run from inside the project, since `cli.ts` is named
from the working directory. With no command, or `help`, `--help` or `-h`, it prints the usage response, which lists
the catalog's machines and these four commands:

```ts packages/backseat-ai/src/runtime/cli.ts
create: { usage: `${bin} create <machine>`, description: 'Start a fresh actor. The response is its id, its state, and the transitions enabled from there.' },
send: { usage: `${bin} send <actorId> <event.type> ['<json payload>' | -]`, description: 'The only way to move an actor. Payload keys follow the schema shown for that event. A - in the payload\'s place reads the JSON from stdin instead.' },
snapshot: { usage: `${bin} snapshot <actorId>`, description: 'Current state and enabled transitions, unchanged. How to orient when handed an id.' },
describe: { usage: `${bin} describe <actorId> [<event.type>]`, description: 'With an event: that one move — where it leads, what it is for and its schema — and nothing else. Without one: the current state with its full first-arrival instructions, its data and its moves.' },
```

`<actorId>` is a root's id, or a child's as `<root>/<key>`. What each response holds, and how a refusal reads, is in
[`driving.md`](./driving.md).

## Exit codes

| Code | `backseat-ai` and `node cli.ts` | `node cli.ts --drive` |
| --- | --- | --- |
| 0 | Done, or the usage printed. | The call answered, including one that reached a final state or errored the actor. |
| 1 | An unknown command or flag, or the command failed. `lint` also exits 1 when it found anything, and `init` when a conflict is left standing. | The call failed: a missing argument, an unknown command, machine or actor, a payload that isn't JSON, or a catalog that didn't load. |
| 2 | Not used. | The runtime refused the event, from `send` or `describe <event>`. The actor didn't move. |

Why each drive exit happens is in [`driving.md`](./driving.md#exit-codes).

## Environment

Where runs live, and the variables that move them, are in [`runs.md`](./runs.md#environment-variables).
