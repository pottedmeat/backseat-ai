# The drive tool targets agent operators, not humans

The tool that fronts a running workflow is driven by an LLM inside a coding harness, never by a person typing ad hoc commands. A person's part is to point their agent at the workflow; every later instruction, next step and piece of state is progressive disclosure surfaced to the agent.

**`node cli.ts --drive` is agent-facing and nothing else: each response tells the agent what it may do next, and there is no human-oriented REPL or command reference on it.** A person's commands live elsewhere and are conventional: `node cli.ts lint` and `node cli.ts stately` for the project's machines, and the `backseat-ai` bin (`output`, `report`, `doctor`, `init`) for runs and setup.

We chose this over a human-first CLI, the usual default, because the point of the runtime is agent-facing progressive disclosure, and a human-first design would optimise for manual, exploratory typing that this tool does not serve. Keeping a person's commands off the drive tool is what lets both stay true to their reader. The cost is two surfaces where one would be conventional.
