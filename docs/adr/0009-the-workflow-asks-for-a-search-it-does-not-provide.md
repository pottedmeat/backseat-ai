# The workflow asks for a search it does not provide

deep-research's worker has to search the web for each query it is handed. A workflow can own a tool and run it through a transition ([ADR-0011](0011-a-transition-may-run-the-tool-it-guards.md)), so the demo could ship a search provider behind an environment key; or it could ship none and ask the agent to search with whatever it has.

**deep-research ships no search provider. The instruction names the act — run the query with whatever web search you have — and the `search.results` event carries only `{ query }`, the query the agent ran.**

A provider puts a third-party account and key between a newcomer and the flagship demo, and its results come under the provider's terms rather than ours. Shipping none keeps the boundary where [ADR-0001](0001-cli-targets-agents-not-humans.md) draws it: Backseat guards the workflow, and an agent can arrive with its own tools. What the agent must send back is still wholly specified, so the guarantee is about the shape of the answer and never about how it was found. Because the event carries only the query, a search's hits never enter the run's record; what a run holds of third parties is the `{ url, title }` citations and the driver's own prose, so a run driven with a real search commits its trace like any other.

The workflow still owns the tools it can own without an account: the worker's `finding.submit` checks each cited source itself, in an effect.

The costs: the workflow depends on a capability it cannot see, verify, or fall back from, so a driver with no web search reaches `searching` and is stuck, and nothing in the machine can warn it in advance; and a run is no longer reproducible, since what a search returns is not the demo's to fix.
