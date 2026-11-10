# The drive protocol reaches a driver on its actor's first presentation, not from the usage response

The drive protocol is the rules for driving an actor with the tool. A subagent handed a child goes straight to that child's id; it never runs the tool bare, asks for `--help` or makes a usage error, so a protocol that lived on the usage response would be filed on the one surface a worker never visits.

**The runtime attaches the drive protocol to the first response any driver receives for a given actor: `create` for a root, or whichever of `snapshot`, `send` or `describe` a child's driver reaches for first, a rejection included. Delivery is spent once per actor, recorded as `agent.taught` in the tracking slice, so it persists across invocations as `visited` does.** The usage response (a bare invocation, `help`, `--help`, `-h`, or a usage error) keeps only the pre-actor surface: the machines the tool fronts, its commands, and how to start.

It is the same progressive-disclosure mechanism as first-arrival instructions, one rung up: the unit is the actor rather than the state. The protocol says two things. What a response is made of and how to use it: every response lists the states reachable from here and under each the event and payload that reach it; read each response before the next call and send only an event it lists; a move shown whole is named alone afterwards and `describe` prints it again ([ADR-0016](0016-a-move-shown-whole-is-then-named.md)). And how to keep the shell out of a payload: pass `-` and feed the JSON on stdin through a quoted heredoc. What a rejection looks like is not taught in advance; a rejection says so itself, on the reply the driver is holding when it matters.

## Considered options

- **Tell the subagent to run the tool bare first.** Declined: it costs a call the worker may simply not make, and hands a worker the machine list and `create`, which are noise to it. It answers a gap in what a worker is told with one more thing a worker must be told.
- **Return the protocol for the parent's driver to paste into each subagent's prompt.** Declined on the same dependence. Delivering per actor costs the same text per child either way, so the choice was never about bytes, only about whether the teaching can be forgotten.
- **Teach only actors whose id has a parent segment.** Declined: it makes teaching conditional on the shape of an id and splits one text into two homes, for no gain over teaching every driver uniformly.
- **Leave it in the usage response as well.** Declined: the root's driver would read it twice, and the invariant is one teaching per driver.

## Consequences

Every rule in the protocol is about invoking a CLI, so the runtime delivers nothing when `RuntimeOptions.bin` is unset. A runtime used without a CLI in front of it teaches silence rather than a paragraph about a command that does not exist.
