# Backseat documentation

Backseat runs an agent's workflow as an [XState](https://stately.ai/docs/xstate) machine that the agent drives. The
agent holds one command-line tool fronting a running actor. From wherever the actor is, the tool shows only the moves
open from there, what each is for, and what it must send to take one, and it refuses a send that doesn't meet that.
Where a framework like LangGraph drives inference calls, Backseat drives a conversation: the agent does the work with
its own tools, and the machine decides which routes are open.

Read them in this order:

1. [`xstate.md`](./xstate.md): the XState concepts a machine is written in, and what Backseat refuses or narrows.
2. [`quickstart.md`](./quickstart.md): setting a project up with `init`, and driving a first machine.
3. [`machines.md`](./machines.md): writing a machine, and the keys Backseat adds.
4. [`subagents.md`](./subagents.md): a machine that hands work to subagents and collects what they return.
5. [`driving.md`](./driving.md): every response a driver sees, how a refusal reads, and the exit codes.
6. [`runs.md`](./runs.md): where a run lives, what each file in it holds, and the commands that read it.
7. [`style.md`](./style.md): the four style rules `lint` checks, and why each holds.
8. [`cli.md`](./cli.md): every command and flag.
9. [`stately.md`](./stately.md): viewing a machine in Stately Studio.

Why Backseat works the way it does is recorded in [`adr/`](./adr/), and the words these pages use are defined in
[`GLOSSARY.md`](../GLOSSARY.md).
