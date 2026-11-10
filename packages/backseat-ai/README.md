# backseat-ai

Guarded agent workflows. You write an [XState](https://stately.ai/docs/xstate) machine, and an agent drives it
through a command-line tool that shows it only the moves open from where it is. The agent drives, and the machine
decides which routes are open.

```
npm install backseat-ai xstate zod
```

It needs Node 22.18 or newer, to run TypeScript machine files directly and to pin a run's code, and TypeScript 5.4 or
newer for its types. It is ESM only. `xstate` and `zod` are peer dependencies, because a machine file imports them too and
must share Backseat's copy. Backseat reads one private field of `xstate`'s inspection events, and CI tests against the
latest `xstate` 5.x so a release that changes it is caught.

## A machine, a catalog, a `cli.ts`

A machine is one TypeScript value:

```ts
// review.ts
import { backseat } from 'backseat-ai'
import { assign } from 'xstate'
import { z } from 'zod'

const { createMachine } = backseat<{ verdict: string | null }, { type: 'verdict.submit'; verdict: string }>()

export const review = createMachine({
  id: 'review',
  description: 'Review a change and give a verdict.',
  context: { verdict: null },
  output: ({ context }) => ({ verdict: context.verdict }),
  initial: 'reading',
  states: {
    reading: {
      description: 'Read the change.',
      instructions: 'Read the change, then send your verdict.',
      on: {
        'verdict.submit': {
          target: 'done',
          description: 'The verdict is in.',
          schema: z.object({ verdict: z.string().min(1).describe('what you concluded') }),
          actions: assign({ verdict: ({ event }) => event.verdict }),
        },
      },
    },
    done: { type: 'final', description: 'Finished.', instructions: 'Tell whoever asked for this the verdict, and why. The review ends here.' },
  },
})
```

A catalog names the machines an agent may create:

```ts
// machines.ts
import { review } from './review.ts'

export default { review }
```

A `cli.ts` names the catalog, and never imports it, so a run can pin the catalog before anything loads it:

```ts
// cli.ts
import { cli } from 'backseat-ai/cli'

await cli(new URL('./machines.ts', import.meta.url))
```

and Node runs it. That is the whole project: a `package.json` with a name, a catalog, and the `cli.ts` beside them. `npx backseat-ai
init` writes all of it, and a `tsconfig.json`, in the working directory. From inside the
project, an agent runs `node cli.ts --drive create review`, and the tool tells it what to send from there.

For the coding agent that writes your machines, a companion skill routes it to the docs this package installs:

```
npx skills add pottedmeat/backseat-ai --skill backseat-ai
```

## What is in the package

| Import | For |
| --- | --- |
| `backseat-ai` | Machine files: `backseat`, `collectChildren`, `RejectedEvent`, `scratchDir`, `currentRun`, and the collection types. |
| `backseat-ai/cli` | `cli()`, which a project's `cli.ts` calls. |

What reads a project's machines runs through its `cli.ts`, so they are driven, linted and drawn by the copy of
Backseat that built them. `node cli.ts --drive` is the agent's, above. `node cli.ts` is for people, not agents:

| Command | What it does |
| --- | --- |
| `node cli.ts lint` | Reports what the style rules can check on each machine of the project. |
| `node cli.ts stately` | Writes each machine of the project as a file to view in Stately Studio. |

The package installs one command, `backseat-ai`, for what reads no catalog. It means the same from anywhere, so run it
with `npx backseat-ai`, or install it once with `npm install -g backseat-ai`.

| Command | What it does |
| --- | --- |
| `backseat-ai init [<name>]` | Sets the working directory up as a project. Replaces nothing you wrote without a yes. |
| `backseat-ai setup` | The same, by the name for afterwards: finishes or repairs a project, any time. |
| `backseat-ai output <actorId>` | Prints a finished actor's output. |
| `backseat-ai report` | Renders a run as a trace report. |
| `backseat-ai doctor` | Offers to remove live runs nobody has touched in 14 days, and calls outside any run as old; `--yes` removes them. |
| `backseat-ai --version` | Prints the version. |

Runs live under your state home while active and under a private `backseat-<uid>` directory in the OS temp dir once
finished, where the OS may clean them up. Set `BACKSEAT_STATE_DIR` to keep a run where you choose.

## Windows

`0.1.0` is untested on Windows. Nothing has been run there yet. A run directory's permissions, `0700` and the check
that you own it, don't apply on Windows, and its temp directory is named by your username rather than a user id.
`init` starts the package manager through a shell there, quoting each argument, and that has never been run either.

## Documentation

The repository's [`docs/`](https://github.com/pottedmeat/backseat-ai/blob/trunk/docs/README.md) has the full
documentation, in this order:

- [The XState a machine is written in](https://github.com/pottedmeat/backseat-ai/blob/trunk/docs/xstate.md)
- [Starting a project](https://github.com/pottedmeat/backseat-ai/blob/trunk/docs/quickstart.md)
- [Writing a machine](https://github.com/pottedmeat/backseat-ai/blob/trunk/docs/machines.md)
- [Handing work to subagents](https://github.com/pottedmeat/backseat-ai/blob/trunk/docs/subagents.md)
- [What a driver sees](https://github.com/pottedmeat/backseat-ai/blob/trunk/docs/driving.md)
- [Where a run lives](https://github.com/pottedmeat/backseat-ai/blob/trunk/docs/runs.md)
- [Checking a machine's style](https://github.com/pottedmeat/backseat-ai/blob/trunk/docs/style.md)
- [Commands](https://github.com/pottedmeat/backseat-ai/blob/trunk/docs/cli.md)
- [Viewing a machine in Stately Studio](https://github.com/pottedmeat/backseat-ai/blob/trunk/docs/stately.md)

MIT licensed.
