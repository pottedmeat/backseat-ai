/**
 * The response as its driver reads it: text, not JSON.
 *
 * The `Summary` is unchanged as the internal model and as the trace's record — `cli.ts` prints and stores separately,
 * so the trace keeps a structured copy and the trace page is untouched. Only the printed bytes change. Everything the
 * runtime carries was already prose inside JSON strings: instructions, every description, `requires`, `message`,
 * `issues[].message`, and the schemas, which are rendered TypeScript. `data` is author-shaped: an object prints as
 * labelled fields, a string or scalar field as text and an array or object field as a fenced JSON block; a `data` that
 * is not an object stays one fenced block (ADR-0013).
 *
 * Two rules the whole file follows:
 *
 * - **Arrival leads with the instructions**, with nothing above them. They are the one thing written to be read on
 *   arrival, and the agent chose this state from a target entry that already told it why.
 * - **A rejection leads with the reason.** A rejection is a different message, not a variant of arrival: the news goes
 *   first and the arrival document follows it. A format that reads well on success and badly on rejection is no
 *   improvement.
 */
import type { Description, Rejection, Summary } from './runtime.js'

/** The pre-actor surface as `cli.ts` builds it: what the tool fronts and how to start. */
export type Usage = {
  bin: string
  machines: Array<{ name: string; description: string }>
  next: string
  commands: Record<string, { usage: string; description: string }>
}

/** Anything the agent-facing bin prints. The usage response and `machines` are not `Summary`s but reach the same driver. */
export type Printable = Summary | Rejection | Description | Usage | { machines: Array<{ name: string; description: string }> }

/**
 * `opening` is the line `create` puts above everything, naming the actor it just made; it is ignored by every document
 * that is not an arrival. `bin` is the tool as it was launched, for the first command printed under each subagent to
 * start; without it no command is printed, as no drive protocol is delivered without one (ADR-0004).
 */
export type RenderOptions = { opening?: string; bin?: string }

const fence = (lang: string, text: string) => '```' + lang + '\n' + text + '\n```'
const isRejection = (value: Printable): value is Rejection => 'rejected' in value && value.rejected === true
const isDescription = (value: Printable): value is Description => 'event' in value
const isSummary = (value: Printable): value is Summary => 'state' in value && Array.isArray((value as Summary).state)
const isUsage = (value: Printable): value is Usage => 'commands' in value

/** The one entry point `cli.ts` prints through. */
export function render(value: Printable, opts: RenderOptions = {}): string {
  if (isUsage(value)) return renderUsage(value)
  if (isRejection(value)) return renderRejection(value, opts)
  if (isDescription(value)) return renderDescription(value)
  if (isSummary(value)) return renderSummary(value, opts)
  return renderMachines(value.machines)
}

/**
 * An arrival. `create` names the actor in its opening line — that call is where the id is born and nothing else says
 * it — and every other response carries it in the footer, where it confirms which actor answered to a driver that
 * supplied the id itself.
 */
export function renderSummary(summary: Summary, opts: RenderOptions = {}): string {
  const blocks: string[] = []
  if (opts.opening) blocks.push(opts.opening)
  // A send's transition instructions come before the state's: that is the order the two happened in.
  if (summary.transition?.instructions) blocks.push(summary.transition.instructions)
  const instructions = summary.state.map((node) => node.instructions).filter((text): text is string => Boolean(text))
  // An errored actor has no guidance to give and the error is the whole news, so it leads; a final state's
  // instructions were written for this exact moment, so there they lead and the status line follows them.
  if (summary.status === 'error') blocks.push(`This actor has errored${summary.error ? `: ${summary.error}` : ''}. Nothing more can be sent.`)
  if (instructions.length) blocks.push(instructions.join('\n\n'))
  else if (summary.status === 'active') blocks.push(`You are at ${where(summary)}.`)
  if (summary.status === 'done') blocks.push('This actor is done. Nothing more can be sent.')

  if (summary.data !== undefined) blocks.push(dataSection(summary.data))
  // The moves, grouped under the state each leads to: `## To move to state: <target>` and its description, then one
  // `### event → target` per move, so a driver can tell states from events by the heading level alone.
  if (summary.status === 'active') blocks.push(moves(summary))
  // Said once, on the call that spawned them, and in the agent's frame: what these are to the agent, and each one's
  // first command, the one fact only the runtime knows.
  // Nothing in the block says child, spawned or actor: "Children this call spawned" was Backseat's own concern, and a
  // driver reading it could take the work as handled and start nothing. A parent that wants more asks the child, so
  // nothing about a running child is repeated on later responses.
  if (summary.children?.length) blocks.push(section('Subagents to start', subagents(summary.children, opts.bin)))
  // Bottom, under its own heading: the instructions are the news and these are scaffolding, and a driver reading
  // top to bottom reaches them before its first send either way (ADR-0004, amended).
  if (summary.protocol) blocks.push(section('How to drive this tool', summary.protocol.driving))
  blocks.push(footer(summary.actorId, where(summary), summary.status))
  return blocks.join('\n\n')
}

/**
 * A rejection: the news, then the arrival document under it. `pending-children` and `refused` already carry a
 * sentence the runtime generated for exactly this moment, so it is used as written rather than restated; the rest
 * name what failed. Every one opens on the same word, which is what the drive protocol now points at.
 */
export function renderRejection(rejection: Rejection, opts: Pick<RenderOptions, 'bin'> = {}): string {
  const blocks: string[] = [`Rejected: ${headline(rejection)}`]
  if (rejection.issues?.length) blocks.push(rejection.issues.map((issue) => `- \`${issue.path}\`: ${issue.message}`).join('\n'))
  if (rejection.schema) blocks.push('The schema for this event:\n\n' + schemaBlock(rejection.schema))
  blocks.push('The actor has not moved.')
  // The transition is dropped: nothing was taken, so there are no transition instructions to hand over.
  const { transition: _transition, ...arrival } = rejection
  return blocks.join('\n\n') + '\n\n' + renderSummary(arrival, { bin: opts.bin })
}

function headline(rejection: Rejection): string {
  switch (rejection.reason) {
    case 'invalid-payload':
      return 'the payload does not match the schema.'
    case 'unknown-event':
      return `that event is not offered from ${where(rejection)}.`
    case 'not-enabled':
      // Defined here, hidden by its guard. A move not offered now is never listed (ADR-0008), so the news is that it is
      // not offered from the state the actor is in, named — not that it is "conditional", which read as a promise.
      return `that event is not offered from the current state, ${where(rejection)}, right now. Send only an event listed below.`
    case 'transition-not-taken':
      return 'no transition took that event from here.'
    case 'pending-children':
    case 'refused':
      return rejection.message ?? 'the implementation refused this event.'
    case 'action-failed':
      // Not a refusal: an action threw. The actor did not move and nothing it did was kept, so the news is the
      // failure itself and that trying again is allowed.
      return `an action failed and nothing it did was kept: ${rejection.message ?? 'no message'}`
    case 'actor-done':
      return 'this actor is done. Nothing more can be sent.'
    case 'actor-error':
      return 'this actor has errored. Nothing more can be sent.'
  }
}

/**
 * `describe <actorId> <event>`: that one move and nothing else, rendered as an arrival renders its moves — under its
 * destination, with the arrow and its schema. The state's instructions and `data` are not repeated: a driver asks for
 * one move's schema, and had to read past thousands of words of instructions to reach it at the bottom (ADR-0015).
 */
export function renderDescription(description: Description): string {
  const blocks: string[] = []
  const event = description.event
  const parts = [toState(event.target.id, event.target.description)]
  const lines = [describedAs(`### ${event.type} → ${event.target.id}`, event.description)]
  if (event.requires) lines.push(`Requires: ${event.requires}`)
  lines.push('', schemaBlock(event.schema))
  parts.push(lines.join('\n'))
  blocks.push(parts.join('\n\n'))
  if (description.protocol) blocks.push(section('How to drive this tool', description.protocol.driving))
  blocks.push(footer(description.actorId, where(description), description.status))
  return blocks.join('\n\n')
}

/** The pre-actor surface. A driver's first call in every recorded run, and prose already — only the braces go. */
export function renderUsage(usage: Usage): string {
  const blocks = [renderMachines(usage.machines, usage.bin), `Start one with \`${usage.next}\`.`]
  const commands = Object.values(usage.commands).map((command) => `\`${command.usage}\`\n${command.description}`)
  blocks.push(section('Commands', commands.join('\n\n')))
  return blocks.join('\n\n')
}

function renderMachines(machines: Array<{ name: string; description: string }>, bin?: string): string {
  const heading = bin ? `\`${bin}\` fronts these machines:` : 'This tool fronts these machines:'
  if (!machines.length) return `${heading}\n\nNone are registered.`
  return `${heading}\n\n` + machines.map((machine) => `- **${machine.name}** — ${machine.description}`).join('\n')
}

/** An error the call did not survive. One string; the braces around it bought nothing. */
export function renderError(message: string, usage?: Usage): string {
  return usage ? `${message}\n\n${renderUsage(usage)}` : message
}

/**
 * The moves open from here, grouped under the state each leads to:
 *
 *     ## To move to state: building (Carry out the plan and run its checks.)
 *
 *     ### plan.submit → building (There is work to do and a plan for it.)
 *
 *         steps: { file: string, change: string }[]   // min 1 items
 *
 * `##` is a state the driver can reach and what it is for; each `###` beneath is an event that gets there, with the
 * arrow repeating the destination so the line reads on its own, then the transition's own description, then its
 * schema as an indented block with the comments in a column. Two heading levels are the whole grammar. A description
 * is in parentheses after the name it describes, on the heading line, in both places (ADR-0017).
 *
 * The `##` says "To move to state:" before the id (ADR-0017). A bare `## recorded` under a refused `vet.record` read as
 * the move having succeeded, and a bare `## <target>` was taken for the state the actor is in, which only the footer
 * names.
 *
 * A move already shown whole in this state, unchanged, is `listed` and goes in one list of names after the moves
 * printed whole, `- event → target`, under a line saying where it was shown and how to see it again (ADR-0016). A
 * destination whose every move is listed loses its heading and description with them.
 */
function moves(summary: Summary): string {
  // Not "Nothing": a move held back for running children is coming, and the refusal that sent the driver here says to
  // send it again (ADR-0008). Which move stays unsaid; only that the wait is the reason.
  if (!summary.targets.length) return summary.awaiting ? 'No move is offered until your subagents finish their workflows.' : 'No move is offered from here right now.'
  const named = summary.targets.flatMap((group) => group.events.filter((event) => event.listed).map((event) => `- ${event.type} → ${group.id}`))
  const whole = summary.targets
    .map((group) => ({ ...group, events: group.events.filter((event) => !event.listed) }))
    .filter((group) => group.events.length)
    .map((group) => {
      const parts = [toState(group.id, group.description)]
      for (const event of group.events) {
        const lines = [describedAs(`### ${event.type} → ${group.id}`, event.description)]
        if (event.requires) lines.push(`Requires: ${event.requires}`)
        if (event.schema) lines.push('', schemaBlock(event.schema))
        else if (event.schemaShown) lines.push(`call describe ${event.type} to see its schema`)
        parts.push(lines.join('\n'))
      }
      return parts.join('\n\n')
    })
  if (named.length) whole.push(`${whole.length ? 'Also offered' : 'Offered'} — each shown in full on an earlier response in this state; call describe <event> to see one whole:\n\n${named.join('\n')}`)
  return whole.join('\n\n')
}

/**
 * A rendered schema as an indented code block: the outer braces go, each field sits at four spaces, and the trailing
 * comments line up in one column so the constraints read as a table beside the types. Only lines whose code fits in
 * {@link ALIGN_WIDTH} set that column; a longer line (a wide enum) keeps its comment right after it, so one long line
 * cannot pad every other line out to its width (ADR-0017). An empty contract says `no payload` in the schema's slot:
 * `{}` read as a shape to fill, not as "send the event alone" (ADR-0017).
 */
function schemaBlock(schema: string): string {
  let lines = schema.split('\n')
  if (lines[0] === '{' && lines[lines.length - 1] === '}') lines = lines.slice(1, -1).map((line) => line.replace(/^  /, ''))
  if (!lines.length || (lines.length === 1 && lines[0] === '{}')) return '    no payload'
  const split: Array<{ code: string; note: string }> = lines.map((line) => {
    const at = line.indexOf(' // ')
    return at === -1 ? { code: line, note: '' } : { code: line.slice(0, at), note: line.slice(at + 4) }
  })
  const width = Math.max(0, ...split.filter((part) => part.note && part.code.length <= ALIGN_WIDTH).map((part) => part.code.length))
  return split.map(({ code, note }) => '    ' + (note ? `${code.padEnd(width)}   // ${note}` : code)).join('\n')
}

/** The widest code a schema line may have and still set the comment column: a terminal's width, the most padding any line pays. */
const ALIGN_WIDTH = 80

/**
 * One entry per subagent to start. The id leads, because the pending refusal and the collection name each one by it;
 * the `about` reads as that agent's purpose; the command under it is the line the agent copies. The command carries
 * no machine name and needs none: the id is the whole address, and `snapshot` finds the machine in the record.
 */
function subagents(children: NonNullable<Summary['children']>, bin?: string): string {
  return children
    .map((child) => {
      const entry = `- ${child.id}${child.about === undefined ? '' : ` — ${aboutText(child.about)}`}`
      return bin === undefined ? entry : `${entry}\n  \`${bin} snapshot ${child.id}\``
    })
    .join('\n')
}

/** One line per child, so the note stays an aside: prose as written, anything else as compact JSON. */
const aboutText = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value))
const where = (summary: Pick<Summary, 'state'>) => summary.state.map((node) => node.id).join(', ')
const section = (heading: string, body: string) => `## ${heading}\n\n${body}`
/**
 * The heading over the moves that reach one state, its description after the name: never the bare id, which read as
 * the state the actor is in.
 */
const toState = (id: string, description?: string) => describedAs(`## To move to state: ${id}`, description)
/**
 * A heading with its description in parentheses after the name, on the one line: one line per target and per move, and
 * the description reads with the name it describes rather than as a line of its own under it (ADR-0017). Without a
 * description, the heading alone.
 */
const describedAs = (heading: string, description?: string) => (description ? `${heading} (${description})` : heading)

/**
 * `- <key>: <type>` — the label above one field of `data`. The type names what follows: text printed as written for a
 * string or another scalar, a fenced JSON block for an array or an object. Exported for the test that pins this
 * form (ADR-0013).
 */
export const fieldLabel = (key: string, value: unknown): string => `- ${key}: ${typeName(value)}`
const typeName = (value: unknown): string => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value)
const fieldValue = (value: unknown): string => (typeof value === 'object' && value !== null ? fence('json', JSON.stringify(value, null, 2)) : String(value))
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * An object `data` prints as fields, one label and its value each, a blank line between them; the fields are the
 * object's own keys in insertion order, an `undefined` value omitted as JSON.stringify omitted it. Anything else —
 * a bare string, an array, a scalar, an object with no fields — keeps the fenced JSON block it always had.
 */
function dataSection(data: unknown): string {
  if (!isRecord(data)) return section('Data', fence('json', JSON.stringify(data, null, 2)))
  const fields = Object.entries(data)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${fieldLabel(key, value)}\n${fieldValue(value)}`)
  return section('Data', fields.length ? fields.join('\n\n') : fence('json', '{}'))
}

/**
 * The id, where the actor is, and its status. The state id lives here rather than in the prose because an arrival's
 * instructions are written without naming the state — and a machine whose outcome *is* which final state it reached
 * would otherwise have no way to say which one that was.
 */
const footer = (actorId: string, state: string, status: string) => `---\n${actorId} · at ${state} · ${status}`
