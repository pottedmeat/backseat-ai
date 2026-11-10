# Context is hidden except for declared data; an actor's output is never returned to the agent

The statechart's job is to make the agent state certain things, in certain shapes, in a certain order. The agent driving an actor already holds every value it sends in, so what it needs back is identity and position (which child is which, which item is current), not the machine's working state.

**Machine context stays hidden from the agent. A value reaches an agent only where it is declared: a state's `data`, `({ context, event }) => unknown`, which the runtime returns while the agent is in that state, or a spawn's `about`, which the parent's own driver is told once on the call that spawns. An actor's `output` is machine-to-machine and is never returned to the agent.** A decision the machine has made is modelled as a branch state rather than revealed: a value the agent needs is declared, a decision is a state.

The premise holds per driver, not across drivers. When a parent's children are driven by subagents, a value the parent's actor holds (what a child reported, received with its outcome) can be one the parent's driver has never seen. It is exposed the ordinary way, by the state that needs it declaring it in `data`. `output` itself still rides to the parent machine and is never echoed; the parent exposes the part its driver needs. Nothing travels back by hand: a parent learns what a child did from the child's outcome and its own `data`, never from prose a subagent was told to write somewhere.

`event` is handed to `data` only on the response to the `send` that carried it, never on a rejection, `snapshot`, `describe` or `create`, and nothing is persisted to make that work. That is how a transition's effect ([ADR-0011](0011-a-transition-may-run-the-tool-it-guards.md)) shows what it returned: the agent did not state that value, so it must be declared to be seen, and it is shown once. What must outlive the call is kept by the transition's actions, in context, where this rule governs it.

`about` is declared at the spawn because a state-level `data` is one function for the whole state and cannot tell two children apart. It reaches only the parent's driver (`input` is what reaches the child), and it is said once, so it cannot grow as an actor runs. A parent that wants to know more about a child it holds the id of asks the child, which answers from its own `data`.

The runtime writes nothing about how an agent spawns or watches subagents; the author decides entirely how to instruct the agent. The one fact only the runtime knows, the command a subagent gives first, it prints: a spawning response lists each child under `## Subagents to start` with its id, its `about` and `node cli.ts --drive snapshot <id>`, and a refused collection names the subagents not yet finished by id.

## Considered options

- **Expose context in the response.** Rejected: it hands the agent the whole workflow's working state, defeating progressive disclosure, and grows without bound as an actor runs.
- **`emit` as an out-channel**, the machine emitting values and child ids for the runtime to relay. Rejected: it is a cooperative protocol the runtime must trust every author to follow at every site, it does not bubble from child to parent, and an entry action's emission on an initial state fires during `start()` before any listener exists. A declared `data` is something the runtime can read and check.
- **Return `output` on completion.** Rejected: the agent stated everything the output contains, so returning it is redundant, and a harness that needs the final artifact uses a different surface from the drive tool (`backseat-ai output`).

## Consequences

A machine that spawns and never tells its driver to hand the children over hangs: the children are created, never driven, never settle, and the collecting transition is refused forever. Nothing mechanical can see it; it is a reviewer's question, not a check.
