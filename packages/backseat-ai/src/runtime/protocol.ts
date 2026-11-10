/**
 * The wording the runtime owns, so every driver is taught the same way.
 *
 * One thing lives here, and it is **placed by nobody**: the runtime attaches the **drive protocol** to the first
 * response any driver receives for a given actor
 * (ADR-0004), because a subagent handed a child is
 * never sent to the usage response and so never read the rules the usage response used to be the only home for.
 *
 * The runtime writes nothing about how an agent spawns subagents: an author writes every word their driver reads on
 * that. What the runtime still owes such a
 * subagent it delivers directly: the drive protocol reaches the child's driver on the child's own first response,
 * and the response that spawns lists each subagent to start with its first command, so an author's handoff sentence need only say to start
 * one for each and give it the command listed — it names no command itself, and so needs no knowledge of the bin.
 */

/**
 * How to drive an actor with this tool. Delivered once per actor, to whoever is driving it, on the first
 * response that actor's driver receives — `create` for a root, the first `snapshot` for a child whose parent's driver
 * handed it over, or a `send` or `describe` if the driver reaches for one of those first.
 */
export type DriveProtocol = {
  /** The rules for driving an actor with this tool. */
  driving: string
}

/** Builds the drive protocol for a tool invoked as `bin`. */
export function driveProtocol(bin: string): DriveProtocol {
  return {
    // Taught per actor rather than per state, and per actor rather than once per tool: both stub live
    // runs batched sends in one shell loop and used the rejection's exit code as the terminator, never reading the
    // response that offered nothing — and a worker in run 5 did the same, having never been shown this at all.
    //
    // Two rules. What a rejection looks like is not taught: the rejection says so itself when it happens. What is taught is what a response is made of, since the two
    // heading levels of the moves block name nothing on their own.
    driving:
      `Every response tells you what you can send next: the states you can reach from here, and under each the event and the payload that must be sent to reach it. Read each one before the next call, and send only an event it lists. A move shown to you whole is named alone on later responses in the same state, until it changes; \`${bin} describe <actorId> <event.type>\` prints it whole again. ` +
      `Every payload passes through your shell, where a quote or apostrophe in free text will eventually break the call before the tool sees it. Pass \`-\` in the payload's place and feed the JSON on stdin instead — \`${bin} send <actorId> <event.type> - <<'JSON'\`, with the delimiter quoted exactly as shown — and nothing in it is re-parsed.`,
  }
}
