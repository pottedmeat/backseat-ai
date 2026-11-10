# Backseat

LangGraph with the roles reversed: the agent drives, the machine decides which routes are open. An agent is handed one tool that fronts an XState actor and sees only the transitions enabled from where it is. Backseat never calls a model.

A machine is one TypeScript value, and a machine that builds is a machine that registers. Every run keeps a trace of each call made against it, which renders as a report.

## Documentation

[`docs/`](docs/README.md) has the full documentation, starting from [the XState a machine is written in](docs/xstate.md) and [starting a project](docs/quickstart.md). The published package is [`backseat-ai`](packages/backseat-ai/README.md):

```
npm install backseat-ai xstate zod
```

The companion skill for a coding agent writing machines is [`skills/backseat-ai`](skills/backseat-ai/SKILL.md):

```
npx skills add pottedmeat/backseat-ai --skill backseat-ai
```

## Layout

| Path | What it is |
| --- | --- |
| `packages/backseat-ai` | The published package. `src/compiler` turns one TypeScript value into the machine the runtime registers, verified where it is built. `src/runtime` drives an actor one call at a time and keeps its run. `src/cli` is the bin, `backseat-ai`, and `cli()`, which a project's own `cli.ts` calls to front its machines. |
| `demos/*` | Real projects consuming Backseat as an installed package: [`one-value`](demos/one-value/README.md), the surface fixture, plus [`pr-review`](demos/pr-review/README.md) and [`deep-research`](demos/deep-research/README.md), which has the recorded run. |
| `docs/` | The documentation, and in [`docs/adr/`](docs/adr/) the decisions behind it. |
| `GLOSSARY.md` | The words the docs and the code use. |
| `skills/backseat-ai` | The companion skill, installed with `npx skills add`. |
| `site/` | [backseat-ai.dev](https://backseat-ai.dev), served as it stands. What it was made from is in `site-src/`. |

## Build and test

Requires Node 22.18 or newer and pnpm.

```sh
pnpm install
pnpm build      # tsc -b in packages/backseat-ai
pnpm typecheck  # tsc -b from the root, across project references, then each demo
pnpm test       # vitest, against sources — no build needed first
```

A demo imports `backseat-ai` as a user would, through its `exports` to `dist`. Under test, vitest aliases
`backseat-ai` and `backseat-ai/cli` onto their `src`, so a test runs against source rather than
the last `dist`. Building is only needed to run the
tools themselves — which the demos do: `pnpm build`, then `node cli.ts --drive` from `demos/one-value`.

`docs.test.ts` checks every code fence in `docs/`: each names the file it quotes after its language, and must appear
there word for word.
