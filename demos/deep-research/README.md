# deep-research

Anthropic's orchestrator-worker research architecture as two Backseat machines. A lead
(`deep-research`) decomposes a research question into sub-tasks, dispatches one worker per
sub-task, judges whether the round answered the question, then drafts a report and cites it.
A worker (`researchTask`) turns one sub-question into a written finding backed by sources.

The claim this demo proves: **a round is a barrier the agent cannot cross early.** Nothing
reaches the lead until it asks, so the round closes on a transition the lead sends and
`collectChildren` gates — sending it while a worker is still running is refused, naming the
worker. The lead never sees its queues, only the position it needs.

Run it from this directory:

```
node cli.ts --drive                       # the catalog
node cli.ts --drive create deep-research  # the initial state
node cli.ts --drive send <actorId> brief.submit - <<'JSON'
{"question":"…"}
JSON
```

The catalog names only the lead: `researchTask` is reached through the lead's roster, and a subagent drives each
worker with the same tool as `<root>/<key>`, from this directory too.

The workflow asks for a web search it does not provide ([ADR-0009](../../docs/adr/0009-the-workflow-asks-for-a-search-it-does-not-provide.md)):
a worker's `searching` state names the act, and the driver brings its own tools.

## What it is measured against

Anthropic published the research system's architecture as prose and its prompts as text, but never its orchestration
code. The reference is therefore the Cookbook prompts,
[`patterns/agents/prompts/`](https://github.com/anthropics/claude-cookbooks/tree/66ab04ad/patterns/agents/prompts)
(`research_lead_agent.md`, `research_subagent.md`, `citations_agent.md`) pinned at commit `66ab04ad`, with
[How we built our multi-agent research system](https://www.anthropic.com/engineering/built-multi-agent-research-system)
(2025-06-13) as the rationale. "Orchestrator-worker" means that system, not Anthropic's generic orchestrator-workers
pattern or other posts that use the same phrase.

The reference puts in prompt prose what this demo puts in statechart structure, so comparing them is a translation
table, not a diff. For each thing the reference tells an agent to do, the machine **forces** it, **instructs** it, or
**omits** it. Matching means **no undocumented divergence**: every difference is named, and either justified as
deliberate or fixed as an oversight. It does not mean parity, because forcing in structure what the reference only
asks for is the point of the demo. The reference's numbers are divergences in this sense. It gives worker counts by
query complexity (at most 20) and a per-worker budget of tool calls (stop near 15 calls or 100 sources). This machine
instead has a round budget judged from the question, 10 to 40 proposed sub-tasks a round, of which the machine picks
some, and 2 to 5 queries a worker.

[`claude-agent-sdk-demos/research-agent`](https://github.com/anthropics/claude-agent-sdk-demos/tree/main/research-agent)
is not the reference, though it is Anthropic's only runnable multi-agent research code. It has no citation agent, no
gap check, no loop until the research is sufficient, strictly linear phases, and every agent on Haiku. Measuring
against it would pull the machine away from the separate citation pass the reference specifies.

A recorded run's trace shows what an agent sent, never what it read. Opening a file is not a CLI call, and a quoting
failure in the driver's shell never reaches the CLI. For those two things, the driver's account is the only evidence.
