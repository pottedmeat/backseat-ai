# A project's own `cli.ts` names the catalog, and the package bin reads none

Whatever reads a catalog has to be the copy of Backseat that built its machines, or whatever one copy recognises by identity the other's machines do not have. A tool resolved from the working directory, or installed globally, cannot promise that.

**Everything that reads a catalog runs through the project's own `cli.ts`**, which names the catalog module by URL and calls `cli()` from `backseat-ai/cli`. The agent's tool is `node cli.ts --drive`, which reaches only `create`, `send`, `snapshot` and `describe` ([ADR-0001](0001-cli-targets-agents-not-humans.md)); a person's `lint` and `stately` are `node cli.ts <command>`. The project is named by the nearest `package.json` above the catalog. Since `cli.ts` imports `backseat-ai/cli` from beside the catalog, the copy that reads the machines is the project's by construction.

**The package's one bin, `backseat-ai`, holds only what reads no catalog**: `output`, `report` and `doctor`, which read the run store, and `init` (also `setup`), which finds a project's machines by reading their source and runs the project's own `node cli.ts --drive` in a child process for the one check that loads them. These mean the same from any copy of Backseat, so they work through `npx backseat-ai` or a global install. `init` works on the working directory and is idempotent: it finishes what is missing (`package.json`, dependencies, `tsconfig.json`, `cli.ts`, a catalog written from the machines it finds), says `ok` to the rest, and replaces nothing a person wrote without a yes.

**Nothing Backseat prints uses a bare `backseat` as a command.** An unrelated npm package ships a `backseat` bin, so `npx backseat` would run a stranger's code and a global install of both would collide. Usage text and errors would keep reintroducing a shorter name, and removing a bin after publishing breaks people where adding an alias later breaks nobody.

`cli.ts` must name the catalog and never import it, or anything that imports it, because the run pins the catalog before loading it. This is caught rather than documented: a `create` whose catalog was already imported is refused ("was imported before the run could pin it"). A root records the tool and the catalog that created it, and a root created from another project's catalog is refused before this one's is imported ("drive it from <project>").

We considered folding `create` and `send` into the person's bin as subcommands, and refused it: the agent would then hold `doctor`. We considered finding the catalog by a fixed file name from the working directory, and refused it for the copy problem above.

The costs: every project carries a `cli.ts` and the trap it guards against; `node cli.ts` must run from the project's directory, so an agent and its subagents drive from there; and `backseat-ai` is longer to type.
