import { describe, expect, it } from 'vitest'
import { fieldLabel, render, renderError, renderSummary } from './render.js'
import type { Usage } from './render.js'
import { driveProtocol } from './protocol.js'
import type { Description, Rejection, Summary } from './runtime.js'

/**
 * What a driver actually reads. `cli.test.ts` asserts the object the trace keeps; this file asserts the text, and the
 * two together are the print/store split.
 */

const arrival: Summary = {
  actorId: 'r1',
  status: 'active',
  state: [{ id: 'briefing', instructions: 'State the research question verbatim.' }],
  targets: [
    {
      id: 'planning',
      description: 'The question is known.',
      events: [{ type: 'brief.submit', schema: '{\n  question: string // min length 10\n}' }],
    },
  ],
}

const lines = (text: string) => text.split('\n')

describe('arrival', () => {
  it('leads with the instructions, with nothing above them', () => {
    // The one rule of an arrival. A heading, a preamble or a restated state id here would each break it.
    expect(lines(render(arrival))[0]).toBe('State the research question verbatim.')
  })

  it('says where the actor is when the author wrote no instructions, so a state is never unnamed', () => {
    const bare = render({ ...arrival, state: [{ id: 'waiting' }] })
    expect(lines(bare)[0]).toBe('You are at waiting.')
  })

  it('carries the id and the state in a footer, and names the actor in an opening line only where create makes one', () => {
    expect(render(arrival)).toContain('---\nr1 · at briefing · active')
    expect(lines(render(arrival))[0]).not.toContain('r1')
    // `create` is the one call that invents the id and the only place nothing else says it.
    const created = renderSummary(arrival, { opening: 'Actor `r1` is running `deepResearch`.' })
    expect(lines(created)[0]).toBe('Actor `r1` is running `deepResearch`.')
  })

  it('groups the moves under the state each leads to, one ### per event with its destination on the line', () => {
    // Two heading levels are the whole grammar: `##` is a state the driver can reach, `###` is an event that gets there.
    const text = render({
      ...arrival,
      targets: [
        ...arrival.targets,
        { id: 'reviewing', description: 'Everyone reported.', events: [{ type: 'research.review', description: 'All back.', requires: 'every child spawned at researching (researchTask) settled' }] },
      ],
    })
    expect(text).toContain('## To move to state: planning (The question is known.)\n\n### brief.submit → planning\n\n    question: string')
    expect(text).toContain('## To move to state: reviewing (Everyone reported.)\n\n### research.review → reviewing (All back.)\nRequires: every child spawned at researching (researchTask) settled')
    expect(text).not.toContain('What you can send')
  })

  it('prints a description in parentheses after the name it describes, on the heading line, in both places', () => {
    // A target's description sat under a blank line and a move's on the next line, both plain sentences, and neither
    // read as "this is what the state (or move) is"; an italic line of its own was read apart from the name too
    // (ADR-0017). One form for both, one line per target and
    // per move, and nothing without a description gets empty parentheses.
    const text = render({
      ...arrival,
      targets: [
        { id: 'planning', description: 'The question is known.', events: [{ type: 'brief.submit', description: 'Give the brief.', schema: '{}' }] },
        { id: 'vetted', description: '', events: [{ type: 'vet.record', schema: '{}' }] },
      ],
    })
    expect(text).toContain('## To move to state: planning (The question is known.)\n\n### brief.submit → planning (Give the brief.)\n\n    no payload')
    expect(text).toContain('## To move to state: vetted\n\n### vet.record → vetted\n\n    no payload')
    expect(text).not.toContain('()')
    expect(text).not.toContain('*')
  })

  it('renders a schema as an indented block, braces gone and comments in a column', () => {
    const text = render({
      ...arrival,
      targets: [{ id: 'planning', description: 'The question is known.', events: [{ type: 'brief.submit', description: 'Give the brief.', schema: '{\n  question: string // min length 10\n  depth?: number\n  tags: {\n    name: string // min length 1\n  }[] // min 1 items\n}' }] }],
    })
    expect(text).toContain('### brief.submit → planning (Give the brief.)\n\n    question: string   // min length 10\n    depth?: number\n    tags: {\n      name: string     // min length 1\n    }[]                // min 1 items')
    // An empty contract says so in words. `{}` in the schema's slot read as a shape to fill in, not as "send the event
    // alone" (ADR-0017); the line sits where the schema would, so the slot is never blank either.
    const bare = render({ ...arrival, targets: [{ id: 'planning', description: '', events: [{ type: 'go', schema: '{}' }] }] })
    expect(bare).toContain('### go → planning\n\n    no payload')
    expect(bare).not.toContain('{}')
  })

  it('one long schema line does not pad the others out to its width', () => {
    // A 517 KB response: one enum line ~10.8 KB wide set the comment column, and ~45 other lines were each padded to
    // it. Lines past the alignment width keep their comment right after the code; the rest still line up (ADR-0017).
    const wide = `node: ${Array.from({ length: 40 }, (_, i) => `"n${String(i).padStart(4, '0')}"`).join(' | ')}`
    const text = render({
      ...arrival,
      targets: [{ id: 'vetted', description: '', events: [{ type: 'vet.record', schema: `{\n  ${wide} // a node the reads printed\n  verdict: string // min length 1\n  why: string // min length 10\n}` }] }],
    })
    expect(text).toContain(`    ${wide}   // a node the reads printed\n    verdict: string   // min length 1\n    why: string       // min length 10`)
    for (const line of text.split('\n')) if (!line.includes(wide)) expect(line.length).toBeLessThan(120)
  })

  it('an omitted schema says to call describe', () => {
    // The runtime drops a schema this actor's driver was already shown; without a pointer the move reads as taking no
    // payload, so it says where the schema is instead (ADR-0016).
    const first = render({ ...arrival, targets: [{ id: 'vetted', description: '', events: [{ type: 'vet.record', schema: '{\n  verdict: string\n}' }] }] })
    expect(first).toContain('### vet.record → vetted\n\n    verdict: string')
    expect(first).not.toContain('call describe')
    const repeat = render({ ...arrival, targets: [{ id: 'vetted', description: '', events: [{ type: 'vet.record', schemaShown: true }] }] })
    expect(repeat).toContain('### vet.record → vetted\ncall describe vet.record to see its schema')
  })

  it('names a move already shown whole in this state, after the moves printed whole, and says how to see it again', () => {
    // Every response repeated every move's heading and description, ~4K tokens the first response in the state had
    // already given (ADR-0016). A move printed by name must still read as offered, and say where the rest of it is.
    const text = render({
      ...arrival,
      targets: [
        { id: 'planning', description: 'The question is known.', events: [{ type: 'brief.submit', description: 'Give the brief.', listed: true }, { type: 'brief.new', description: 'New here.', schema: '{}' }] },
        { id: 'vetted', description: 'Vetted.', events: [{ type: 'vet.record', description: 'Record it.', listed: true }] },
      ],
    })
    expect(text).toContain('## To move to state: planning (The question is known.)\n\n### brief.new → planning (New here.)')
    expect(text).toContain('Also offered — each shown in full on an earlier response in this state; call describe <event> to see one whole:\n\n- brief.submit → planning\n- vet.record → vetted')
    expect(text).not.toContain('Give the brief.')
    expect(text).not.toContain('## To move to state: vetted')
    // Every move named: no heading at all, and the list says "Offered".
    const named = render({ ...arrival, targets: [{ id: 'vetted', description: 'Vetted.', events: [{ type: 'vet.record', listed: true }] }] })
    expect(named).toContain('Offered — each shown in full on an earlier response in this state; call describe <event> to see one whole:\n\n- vet.record → vetted')
    expect(named).not.toContain('## To move to state')
    // A refusal's news still leads.
    const refused = render({ ...arrival, targets: [{ id: 'vetted', description: 'Vetted.', events: [{ type: 'vet.record', listed: true }] }], rejected: true, reason: 'unknown-event' } as Rejection)
    expect(lines(refused)[0]).toBe('Rejected: that event is not offered from briefing.')
    expect(refused).toContain('- vet.record → vetted')
  })

  it('says so plainly when nothing can be sent, and why when a move is waiting on subagents', () => {
    // "Nothing." read as a dead end under instructions and a refusal that both say the move comes once the children
    // are back; the wait is named, the held-back move is not (ADR-0008).
    expect(render({ ...arrival, targets: [] })).toContain('No move is offered from here right now.')
    expect(render({ ...arrival, targets: [], awaiting: true })).toContain('No move is offered until your subagents finish their workflows.')
    expect(render({ ...arrival, targets: [] })).not.toContain('Nothing.')
  })

  it('data renders as key/value fields', () => {
    // The human's form: a label naming the key and its type, then the value — text for a string or scalar, a fenced
    // block for an array or object — a blank line between fields. Prose the machine formatted is read as prose, and the
    // keys `data.<key>` prose names are still there to name (ADR-0013).
    const text = render({ ...arrival, data: { result: '### 3 hits for "x"\n\nfirst', resultSet: 'rs-4f2a', round: 2, done: false, gap: null, blocks: ['pt:07:0412', 'wu:03:0088'], meta: { k: 1 } } })
    expect(text).toContain(
      '## Data\n\n- result: string\n### 3 hits for "x"\n\nfirst\n\n- resultSet: string\nrs-4f2a\n\n- round: number\n2\n\n- done: boolean\nfalse\n\n- gap: null\nnull\n\n- blocks: array\n```json\n[\n  "pt:07:0412",\n  "wu:03:0088"\n]\n```\n\n- meta: object\n```json\n{\n  "k": 1\n}\n```\n\n## To move to state: planning',
    )
  })

  it('keeps a data that is not an object as one fenced JSON block, a bare string included', () => {
    // A string on its own is not a field; printing it unfenced was withdrawn (contract decision 3).
    expect(render({ ...arrival, data: ['a', 'b'] })).toContain('## Data\n\n```json\n[\n  "a",\n  "b"\n]\n```')
    expect(render({ ...arrival, data: 'plain' })).toContain('## Data\n\n```json\n"plain"\n```')
    expect(render({ ...arrival, data: {} })).toContain('## Data\n\n```json\n{}\n```')
    expect(render({ ...arrival, data: { a: undefined, b: 'x' } })).toContain('## Data\n\n- b: string\nx\n\n## To move to state: planning')
  })

  it('labels a field with its key and the type of what follows', () => {
    expect(fieldLabel('blocks', [])).toBe('- blocks: array')
    expect(fieldLabel('gap', null)).toBe('- gap: null')
    expect(fieldLabel('meta', {})).toBe('- meta: object')
    expect(fieldLabel('result', 'text')).toBe('- result: string')
  })

  it('puts a transition\'s instructions above the state it landed in, the order the two happened in', () => {
    const text = render({ ...arrival, transition: { type: 'conclude', instructions: 'Say goodbye.' } })
    expect(lines(text).slice(0, 3)).toEqual(['Say goodbye.', '', 'State the research question verbatim.'])
  })

  it('lists the subagents to start, each with its purpose and the first command to give it', () => {
    // In the agent's frame: "Children this call spawned" was Backseat's own concern, and a driver reading it
    // could take the work as handled and start nothing. The id leads, because the pending refusal names each one by
    // it; the command is the line the agent copies, and carries no machine name, since the id is the whole address.
    const text = render({ ...arrival, children: [{ id: 'r1/task-1-0', about: 'Which lakes suit fishing with kids?' }, { id: 'r1/task-1-1' }] }, { bin: 'node cli.ts --drive' })
    expect(text).toContain('## Subagents to start\n\n- r1/task-1-0 — Which lakes suit fishing with kids?\n  `node cli.ts --drive snapshot r1/task-1-0`\n- r1/task-1-1\n  `node cli.ts --drive snapshot r1/task-1-1`\n\n')
    expect(text).not.toContain('Children this call spawned')
    // Without a bin there is no command to print: the runtime names a command only when it knows the one it was
    // launched as, the rule the drive protocol already follows (ADR-0004).
    expect(render({ ...arrival, children: [{ id: 'r1/task-1-0' }] })).toContain('## Subagents to start\n\n- r1/task-1-0\n\n---')
  })

  it('puts the drive protocol at the bottom, under its own heading', () => {
    const text = render({ ...arrival, protocol: driveProtocol('machine') })
    expect(text).toContain('## How to drive this tool')
    // Below the instructions and below the moves: the instructions are the news, these are scaffolding.
    expect(text.indexOf('## How to drive this tool')).toBeGreaterThan(text.indexOf('## To move to state: planning'))
    expect(lines(text)[0]).toBe('State the research question verbatim.')
  })

  it('leads with the error on an errored actor, and follows the instructions on a done one', () => {
    const errored = render({ ...arrival, status: 'error', error: 'disk on fire', targets: [] })
    expect(lines(errored)[0]).toBe('This actor has errored: disk on fire. Nothing more can be sent.')
    // A final state's instructions were written for this exact moment, so there they still lead.
    const done = render({ ...arrival, status: 'done', state: [{ id: 'complete', instructions: 'Tell them the id and stop.' }], targets: [] })
    expect(lines(done)[0]).toBe('Tell them the id and stop.')
    expect(done).toContain('This actor is done. Nothing more can be sent.')
    // A machine whose outcome *is* which final state it reached still says which one.
    expect(render({ ...arrival, status: 'done', state: [{ id: 'accepted' }], targets: [] })).toContain('---\nr1 · at accepted · done')
  })
})

describe('rejection', () => {
  const rejection = (extra: Partial<Rejection>): Rejection => ({ ...arrival, rejected: true, reason: 'invalid-payload', ...extra })

  it('says what went wrong on the first line, which is the whole point of the change', () => {
    // Run 2's only rejection put `"reason": "invalid-payload"` on line 40 of a 1,889-byte document, under the
    // instructions, the targets and two paragraphs of `data`.
    const text = render(rejection({ issues: [{ path: 'queries', message: 'Too big: expected array to have <=5 items' }], schema: '{\n  queries: string[]\n}' }))
    expect(lines(text)[0]).toBe('Rejected: the payload does not match the schema.')
    expect(lines(text)[2]).toBe('- `queries`: Too big: expected array to have <=5 items')
    expect(text).toContain('The schema for this event:\n\n    queries: string[]')
    expect(text).toContain('The actor has not moved.')
  })

  it('opens on the same word whatever the reason, which is what the drive protocol now points at', () => {
    const reasons: Array<Rejection['reason']> = ['invalid-payload', 'unknown-event', 'not-enabled', 'transition-not-taken', 'pending-children', 'refused', 'actor-done', 'actor-error']
    for (const reason of reasons) {
      expect(lines(render(rejection({ reason, message: 'do it differently' })))[0]).toMatch(/^Rejected: /)
    }
  })

  it('uses the sentence the runtime already generated, rather than restating it', () => {
    // `pending-children` and `refused` both arrive with a sentence written for exactly this moment.
    const pending = render(rejection({ reason: 'pending-children', message: 'these subagents have not finished their workflows: r1/task-1-0. Send research.review again once they have.' }))
    expect(lines(pending)[0]).toBe('Rejected: these subagents have not finished their workflows: r1/task-1-0. Send research.review again once they have.')
    const refused = render(rejection({ reason: 'refused', message: 'finding.md already exists; send again with "overwrite": true' }))
    expect(lines(refused)[0]).toBe('Rejected: finding.md already exists; send again with "overwrite": true')
  })

  it('heads each destination "To move to state:", so a refused move\'s destination does not read as where the actor went', () => {
    // A refused `vet.record` printed `## recorded` under the refusal, and agents read it as success; a bare `## <target>`
    // was also taken for the current state (ADR-0017). The news stays first, and only the footer says where the actor is.
    const text = render(rejection({ reason: 'invalid-payload', targets: [{ id: 'recorded', description: 'The verdict is in.', events: [{ type: 'vet.record', schemaShown: true }] }] }))
    expect(lines(text)[0]).toBe('Rejected: the payload does not match the schema.')
    expect(text).toContain('## To move to state: recorded (The verdict is in.)\n\n### vet.record → recorded')
    expect(lines(text)).not.toContain('## recorded')
    expect(text).toContain('---\nr1 · at briefing · active')
  })

  it('follows the news with the arrival document, so the driver can act without another call', () => {
    const text = render(rejection({ reason: 'unknown-event' }))
    expect(lines(text)[0]).toBe('Rejected: that event is not offered from briefing.')
    expect(text).toContain('State the research question verbatim.')
    expect(text).toContain('## To move to state: planning (The question is known.)\n\n### brief.submit → planning')
  })

  it('says a guarded-off event is not offered from the current state, and names that state', () => {
    // "Conditional" read as a promise the move was there to be had; a move not offered now is never listed (ADR-0008),
    // so the refusal says where the actor is and points at what is.
    const text = render(rejection({ reason: 'not-enabled' }))
    expect(lines(text)[0]).toBe('Rejected: that event is not offered from the current state, briefing, right now. Send only an event listed below.')
    expect(text).not.toContain('conditional')
    // Still followed by the arrival document, like every rejection.
    expect(text).toContain('The actor has not moved.')
  })

  it('drops the transition, nothing having been taken', () => {
    expect(render(rejection({ transition: { type: 'conclude', instructions: 'Say goodbye.' } }))).not.toContain('Say goodbye.')
  })
})

describe('describe', () => {
  const description: Description = {
    actorId: 'r1',
    status: 'active',
    state: [{ id: 'briefing' }],
    event: { type: 'brief.submit', description: 'Give the brief.', schema: '{\n  question: string\n}', target: { id: 'planning', description: 'The question is known.' } },
  }

  it('prints the one move and its footer, nothing else, so the schema a driver asked for is not the last thing on the page', () => {
    // It used to print the state's full instructions and data above the move — thousands of words before the schema —
    // and drivers sent empty payloads to learn schemas instead (ADR-0015).
    expect(render(description)).toBe('## To move to state: planning (The question is known.)\n\n### brief.submit → planning (Give the brief.)\n\n    question: string\n\n---\nr1 · at briefing · active')
  })

  it('still teaches a driver whose first call it is, since the protocol rides the first response whatever it is', () => {
    const text = render({ ...description, protocol: driveProtocol('machine') })
    expect(text.indexOf('## How to drive this tool')).toBeGreaterThan(text.indexOf('    question: string'))
  })
})

describe('the pre-actor surface', () => {
  const usage: Usage = {
    bin: 'machine',
    machines: [{ name: 'deepResearch', description: 'Research a question end to end.' }],
    next: 'machine create <machine>',
    commands: { create: { usage: 'machine create <machine>', description: 'Start a fresh actor.' } },
  }

  it('renders the usage response as prose, a driver\'s first call in every recorded run', () => {
    const text = render(usage)
    expect(text).toContain('`machine` fronts these machines:')
    expect(text).toContain('- **deepResearch** — Research a question end to end.')
    expect(text).toContain('Start one with `machine create <machine>`.')
    expect(text).toContain('## Commands\n\n`machine create <machine>`\nStart a fresh actor.')
  })

  it('renders the machines list on its own, and says so when there are none', () => {
    expect(render({ machines: usage.machines })).toContain('- **deepResearch** — Research a question end to end.')
    expect(render({ machines: [] })).toContain('None are registered.')
  })

  it('renders an error as its message, with the usage under it when that is what sent the driver here', () => {
    expect(renderError('Unknown actor \'nope\'')).toBe('Unknown actor \'nope\'')
    expect(renderError('missing <actorId>', usage)).toContain('missing <actorId>\n\n`machine` fronts these machines:')
  })
})
