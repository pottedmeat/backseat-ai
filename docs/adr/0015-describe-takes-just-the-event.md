# `describe` takes just the event

A driver that asks for one move's schema needs that schema, not the state's full instructions above it. When the schema came last, under thousands of words, drivers sent empty payloads to learn it from the refusal instead.

**`describe <actorId> <event>` prints that one move and nothing else**: the `## To move to state:` heading of the state it leads to with that state's description, the `### event → state` line with the transition's description and any `Requires:`, the schema, and the footer. It names the active states by id alone and carries no `data`. It refuses a move that is not offered now, as `send` would, records the schema as shown, and never prints the "call describe" line. The drive protocol rides it when it is the driver's first response, as on any first response ([ADR-0004](0004-drive-protocol-on-first-presentation.md)).

**The actor stays in the form.** An event is resolved against one actor's machine and state: its target, its guard and a schema that is a function of context all depend on them, and a child's events are not its parent's. There is no `describe <event>`.

**`describe <actorId>`, with no event, returns the current state whole**: as an arrival, but with the first-arrival instructions whatever has been seen, its `data`, and every move printed whole ([ADR-0016](0016-a-move-shown-whole-is-then-named.md)). Once a state has been visited, nothing else reaches that text: `snapshot` hands back the revisit instructions, and a driver taking over an actor mid-flight needs the first account.
