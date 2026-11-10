# How a move is printed

Every response that leaves an actor active ends in a moves block: the moves open from here, grouped under the state each leads to. The same block follows an arrival, a `snapshot`, a rejection and `describe <actorId> <event>`, so it has to read right in all of them, including just under a `Rejected:` line.

**One helper in `render.ts` prints every moves block, in this shape:**

```
## To move to state: researching (Workers are being dispatched and are running.)

### task.next → researching (Another sub-task is waiting to be dispatched.)

    no payload
```

**A destination heading reads `## To move to state: <target>`.** A bare `## <target>` read wrong under a refusal: a refused `vet.record` printed `## recorded` under its `Rejected:` line, and agents took it to mean the record had gone through. A bare target was also mistaken for the state the actor is in. Only the footer says where the actor is. One wording everywhere, so a driver learns it once. `## Data`, `## How to drive this tool` and `## Subagents to start` keep their plain headings, since they are sections and not destinations.

**A description goes in parentheses after the name it describes, on the heading line**, for a target and for a move. That gives one line per target and per move, and the description reads as an aside on the name. We rejected an italic line under the heading, because it read as a line of its own. We also rejected a `Description:` line, and the thing's own name as a label (`search.results: That was the last query.`), because the name repeats the heading and looks like a `## Data` field. A target or move with no description prints its name alone. The cost: a description that ends in `)` would look like it closes the parentheses early.

**A schema prints as an indented block without its outer braces, with fields at four spaces and the trailing `// …` constraints lined up in one column. Only a line whose code is at most 80 characters sets that column.** A longer line keeps its comment right after its code and pads nothing. Before this limit, one wide enum set the column for the whole schema, and a response grew to 517 KB, mostly spaces. 80 is a terminal's width. Ordinary fields stay in the column, and a generated enum or union never sets it.

**A move whose contract has no fields prints `    no payload` where its schema would go**, including after a rejection's `The schema for this event:`. `{}` looked like an object to fill in, not like "send the event alone". The words sit in the schema's slot, so a move always has something there: its schema, `no payload`, or the `call describe` line for a schema shown earlier ([ADR-0016](0016-a-move-shown-whole-is-then-named.md)). This only changes the text the agent reads. The rendered schema is still `{}`, so the digest that decides whether a move is shown whole or named, and what gets recorded as presented, don't change.
