import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { assign, setup } from 'xstate'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentTracking, buildCli, currentRun, fileStore, listRuns, noPin, outputOf, pinnedLocator, pinPath, readPin, readTrace, RejectedEvent, runsDirs, runsLocator, scratchDir, setCurrentRun } from './index.js'
import type { AgentMeta, AgentTrackingContext, AgentTrackingEvent, CliOptions, RunsDirs } from './index.js'

// A lead that spawns two workers, joins on their done events, and finishes with an output. Enough to exercise
// state surviving between processes, two agents driving siblings at once, and output retrieval.

const worker = setup({
  types: {
    context: {} as { agent: AgentTrackingContext; q: string },
    input: {} as { q: string },
    events: {} as AgentTrackingEvent | { type: 'FINISH'; note: string },
    meta: {} as AgentMeta,
  },
}).createMachine({
  id: 'worker',
  description: 'One unit of work.',
  context: ({ input }) => ({ ...agentTracking.context, q: input.q }),
  output: ({ context }) => ({ q: context.q }),
  on: { ...agentTracking.on },
  initial: 'working',
  states: {
    working: { description: 'Work is pending.', meta: { data: ({ context: { q } }) => ({ q }) }, on: { FINISH: 'done' } },
    done: { type: 'final', description: 'Finished.', meta: { schema: z.object({ note: z.string() }) } },
  },
})

const lead = setup({
  actors: { worker },
  types: {
    context: {} as { agent: AgentTrackingContext; question: string; tallied: number },
    events: {} as AgentTrackingEvent | { type: 'brief.submit'; question: string } | { type: 'round.tally' } | { type: 'round.review' } | { type: 'finish' },
    meta: {} as AgentMeta,
  },
  guards: { tallied: ({ context }) => context.tallied + 1 >= 2 },
}).createMachine({
  id: 'lead',
  description: 'Test lead.',
  context: { ...agentTracking.context, question: '', tallied: 0 },
  output: ({ context }) => ({ report: `answer to ${context.question}` }),
  on: { ...agentTracking.on },
  initial: 'briefing',
  states: {
    briefing: {
      description: 'No question yet.',
      meta: { instructions: 'State the question.' },
      on: { 'brief.submit': 'working' },
    },
    working: {
      description: 'Workers are out.',
      meta: { schema: z.object({ question: z.string().min(3) }), data: ({ context: { question } }) => ({ question }), sites: [{ src: 'worker' }] },
      entry: assign({
        question: ({ event, spawn }) => {
          spawn('worker', { id: 'w-0', input: { q: 'a' } })
          spawn('worker', { id: 'w-1', input: { q: 'b' } })
          return (event as { question: string }).question
        },
      }),
      // The lead leaves on its own send, refused while either worker is still out. A worker finishing is that
      // worker's move: it can no longer carry the lead anywhere, which is the whole of ADR-0008 made mechanical.
      on: {
        'round.review': { target: 'reviewing', description: 'Both workers are back.', meta: { settled: [{ state: 'working', src: 'worker' }] } },
        // A deliberate contest on one event: the first send takes the branch with no target and the second takes the
        // guarded one, so the landing state cannot tell them apart and only the journey's steps can. It used to
        // be keyed on the workers' done event, which is now refused; the shape is the same, the sender is not.
        'round.tally': [
          { guard: 'tallied', target: 'briefing', description: 'Enough; brief again.', actions: assign({ tallied: ({ context }) => context.tallied + 1 }) },
          { description: 'Counted.', actions: assign({ tallied: ({ context }) => context.tallied + 1 }) },
        ],
      },
    },
    reviewing: { description: 'Both workers reported.', on: { finish: 'complete' } },
    complete: { type: 'final', description: 'Done.' },
  },
})

// A machine that owns its tool: one read, called through a transition, whose output the trace keeps whole.
const looker = setup({
  types: {
    context: {} as { agent: AgentTrackingContext },
    events: {} as AgentTrackingEvent | { type: 'look'; id: string },
    meta: {} as AgentMeta,
  },
}).createMachine({
  id: 'looker',
  description: 'Looks things up.',
  context: { ...agentTracking.context },
  on: { ...agentTracking.on },
  initial: 'looking',
  states: {
    looking: {
      description: 'Looking.',
      meta: { data: ({ event }) => (event?.output === undefined ? {} : { found: (event.output as { title: string }).title }) },
      on: {
        look: {
          description: 'Look one up.',
          meta: {
            schema: z.object({ id: z.string() }),
            effect: async ({ event }) => {
              if (event.id === 'missing') throw new RejectedEvent('Nothing by that id.')
              return { id: event.id, title: `Title of ${event.id}`, body: 'the whole of it' }
            },
          },
        },
      },
    },
  },
})

let dir: string
let out: string[]
let err: string[]
let ids: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'backseat-cli-'))
  ids = ['r1', 'r2']
  out = []
  err = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (out.push(String(chunk)), true))
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (err.push(String(chunk)), true))
  process.exitCode = undefined
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
  // A run's scratch is a sibling of the run, so removing the state directory does not take it.
  for (const id of ['r1', 'r2']) rmSync(scratchDir(id), { recursive: true, force: true })
  process.exitCode = undefined
})

/** A separate `buildCli` per call stands in for a separate process: nothing but the state directory is shared. */
const invoke = (argv: string[], extra: Partial<CliOptions> = {}) => {
  const cli = buildCli({ bin: 'test', machines: { lead }, stateDir: dir, createId: () => ids.shift() ?? 'r?', ...extra })
  return cli.run(argv)
}
/**
 * The response object as the trace recorded it. The driver now reads text, so stdout can no longer be parsed — but
 * `cli.ts` prints and stores separately and the trace keeps the structured copy unchanged, which is the seam this
 * whole change rests on. Asserting through it therefore
 * exercises that seam on every one of these tests. Under a pinned locator every call, actor or not, traces to the one
 * directory; the unpinned `runs` block passes its own. The printed text has its own tests in `render.test.ts`, and
 * `printed` below is what a driver actually saw.
 */
const last = (where: string = dir) => readTrace(where).at(-1)?.response as any
const lastErr = () => (err.at(-1) ?? '').trimEnd()

/** Stand in for the pipe or heredoc a driver feeds `send ... -`; real stdin arrives as chunks of bytes. */
const stdin = (text: string) => vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from([Buffer.from(text, 'utf8')]) as unknown as typeof process.stdin)

async function startRun() {
  await invoke(['create', 'lead'])
  await invoke(['send', 'r1', 'brief.submit', JSON.stringify({ question: 'why?' })])
  return last()
}

describe('lifecycle', () => {
  it('state survives across invocations because each one rehydrates the root from its file', async () => {
    await invoke(['create', 'lead'])
    expect(last().actorId).toBe('r1')
    expect(last().state[0].instructions).toBe('State the question.')
    await invoke(['snapshot', 'r1'])
    // the first invocation recorded the visit; the second shows the revisit form, proving the tracking slice persisted
    expect(last().state[0].instructions).toBe('State the question.')
    expect(last().targets[0].events[0].schema).toBeUndefined()
    expect(process.exitCode).toBeUndefined()
  })

  it('a rejected event exits 2 and leaves the actor where it was', async () => {
    await invoke(['create', 'lead'])
    await invoke(['send', 'r1', 'brief.submit', '{"question":"no"}'])
    expect(last()).toMatchObject({ rejected: true, reason: 'invalid-payload', state: [{ id: 'briefing' }] })
    expect(process.exitCode).toBe(2)
    process.exitCode = undefined
    await invoke(['snapshot', 'r1'])
    expect(last().state[0].id).toBe('briefing')
  })

  it('two agents finishing sibling workers at once both land, because invocations on one root are serialised', async () => {
    const started = await startRun()
    expect(started.children.map((c: { id: string }) => c.id)).toEqual(['r1/w-0', 'r1/w-1'])
    await Promise.all([invoke(['send', 'r1/w-0', 'FINISH', '{"note":"x"}']), invoke(['send', 'r1/w-1', 'FINISH', '{"note":"y"}'])])
    // Both landed, and neither moved the lead: it is still where its own agent left it until its own agent sends.
    await invoke(['snapshot', 'r1'])
    expect(last().state[0].id).toBe('working')
    await invoke(['send', 'r1', 'round.review'])
    expect(last().state[0].id).toBe('reviewing')
  })
})

describe('the stdin payload form', () => {
  // Run 5's driver lost a `plan.submit` to a zsh apostrophe before the CLI ever saw it, so the payload stops
  // passing through the shell. The failure lives in the driver's shell, where no trace and no live run can see it;
  // this is the only place it is instrumented.
  const nasty = 'it\'s "quoted", $HOME, `backticks`\nand a newline'

  it('carries a payload the shell would have broken, byte for byte, exactly as argv does', async () => {
    await invoke(['create', 'lead'])
    await invoke(['send', 'r1', 'brief.submit', JSON.stringify({ question: nasty })])
    const viaArgv = last().data

    await invoke(['create', 'lead'])
    stdin(JSON.stringify({ question: nasty }))
    await invoke(['send', 'r2', 'brief.submit', '-'])
    expect(last().actorId).toBe('r2') // the response is the stdin send's own, not the argv send still on stdout
    expect(last().data.question).toBe(nasty)
    expect(last().data).toEqual(viaArgv)
    expect(process.exitCode).toBeUndefined()
    // The trace holds what the runtime received, not the '-' argv carried, so a report of this run shows the payload.
    const entry = readTrace(dir).at(-1)!
    expect(entry.argv[3]).toBe('-')
    expect(entry.payload).toEqual({ question: nasty })
  })

  it('fails loudly on empty stdin rather than sending an empty payload', async () => {
    await invoke(['create', 'lead'])
    stdin('')
    await invoke(['send', 'r1', 'brief.submit', '-'])
    expect(lastErr()).toMatch(/JSON/)
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
    await invoke(['snapshot', 'r1'])
    expect(last().state[0].id).toBe('briefing') // left where it was, as any unparseable payload leaves it
  })
})

describe('output', () => {
  // `output` is not a command of this bin: reading a finished actor's result is a person's act, and `backseat-ai output`
  // is where it lives. What is left here is the read itself, over the record a real run wrote, because that
  // record is this package's and the states it can be caught in — active, a live child, a finished root — are the
  // runtime's to get right. The human bin's own test drives the command.
  const read = (actorId: string) => outputOf(fileStore(dir), actorId)

  it('is refused while the actor is active and read from the persisted record once done, for children too', async () => {
    await startRun()
    await expect(read('r1')).rejects.toThrow("Actor 'r1' has no output: it is active")

    await invoke(['send', 'r1/w-0', 'FINISH', '{"note":"x"}'])
    expect(await read('r1/w-0')).toEqual({ actorId: 'r1/w-0', status: 'done', output: { q: 'a' } })

    await invoke(['send', 'r1/w-1', 'FINISH', '{"note":"y"}'])
    await invoke(['send', 'r1', 'round.review'])
    await invoke(['send', 'r1', 'finish'])
    expect(last().status).toBe('done')
    expect(last().output).toBeUndefined() // the agent tool never carries it
    expect(await read('r1')).toEqual({ actorId: 'r1', status: 'done', output: { report: 'answer to why?' } })
  })
})

describe('disclosure', () => {
  it('a bare invocation discloses the entry brief, and a usage error re-discloses it', async () => {
    await invoke([])
    expect(last().machines).toEqual([{ name: 'lead', description: 'Test lead.' }])
    expect(last().next).toBe('test create <machine>')
    // The whole surface, and all of it: a project declares no commands of its own and there is no unadvertised fifth
    // to guess at. A helper a machine needs is a script its instructions name.
    expect(Object.keys(last().commands)).toEqual(['create', 'send', 'snapshot', 'describe'])

    await invoke(['send'])
    expect(last()).toMatchObject({ error: 'missing <actorId>', usage: { next: 'test create <machine>' } })
    expect(lastErr()).toContain('test create <machine>') // and the driver reads it, under the message that sent it here
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined

    // `describe` without an event was once a subset of `snapshot` under a promise of full instructions and became a
    // usage error. With an event it now prints that move alone (ADR-0015), so the bare form is where the full
    // first-arrival instructions live — and it delivers them, which `snapshot` does not once the state has been seen.
    await invoke(['create', 'lead'])
    await invoke(['describe', 'r1'])
    expect(process.exitCode).toBeUndefined()
    expect(last().event).toBeUndefined()
    expect(last().targets.length).toBeGreaterThan(0)
    await invoke(['help'])
    expect(last().commands.describe.usage).toBe('test describe <actorId> [<event.type>]')
  })

  it('a bare invocation is the pre-actor surface only: what to start, never how to drive', async () => {
    // The drive rules used to live here, and only here. A subagent handed a child is told to run `snapshot <childId>`
    // and never comes back to this page, so across seven live runs 15 of the 30 workers provably read it zero times.
    // What a response carries and how to drive with one now rides each actor's first presentation instead.
    await invoke([])
    expect(Object.keys(last())).toEqual(['bin', 'machines', 'next', 'commands'])
    // The send line keeps both payload forms: it is how to *call* the tool, which is what this page is for.
    expect(last().commands.send.usage).toBe("test send <actorId> <event.type> ['<json payload>' | -]")
    expect(last().commands.send.description).toMatch(/reads the JSON from stdin/)
  })

  it('teaches the drive protocol on an actor\'s first response, once, and never again', async () => {
    // Both stub live runs batched five `task.dispatch` sends in one shell loop and used the rejection's exit code as
    // the terminator, never reading the response that offered nothing. The rule is taught once per actor, so a
    // batched loop is a violation of something that driver has seen rather than a shortcut it found.
    await invoke(['create', 'lead'])
    const taught = last().protocol
    // Two rules, where there were three. The six-key map of response keys went with the JSON it described, and so did
    // the zsh rule — it existed because a schema reached the driver with *escaped* newlines, and a rendered
    // response has real ones.
    expect(Object.keys(taught)).toEqual(['driving'])
    expect(taught.driving).toMatch(/Read each one before the next call, and send only an event it lists/)
    // What a response is made of is taught, because the moves block's two heading levels name nothing on their own.
    expect(taught.driving).toMatch(/the states you can reach from here, and under each the event and the payload that must be sent to reach it/)
    // A move is named alone after its first full showing in a state (ADR-0016), so the driver is told where the rest went.
    expect(taught.driving).toContain('test describe <actorId> <event.type>` prints it whole again')
    // What a rejection looks like is not: the rejection says so itself when it happens.
    expect(taught.driving).not.toMatch(/Rejected|exit code/)
    expect(taught.driving).not.toMatch(/echo/)
    // The apostrophe that broke run 5's plan.submit, with the heredoc delimiter quoted as it must be typed.
    expect(taught.driving).toMatch(/Pass `-` in the payload's place and feed the JSON on stdin instead/)
    expect(taught.driving).toContain("test send <actorId> <event.type> - <<'JSON'")

    // Spent like any other first-arrival disclosure, and spent in context, so a separate process does not re-teach it.
    await invoke(['snapshot', 'r1'])
    expect(last().protocol).toBeUndefined()
  })

  it('teaches a handed-over child\'s driver on its own first look, whatever the parent already knows', async () => {
    // The lead's driver reads the tool once and the workers drive on whatever they brought with
    // them. Run 5's worker sent `search.results` for the wrong query, was rejected with the expected query quoted back
    // at it, and re-sent a byte-identical 3,871-char payload — rule one, broken by an agent never shown it.
    await startRun()
    expect(last().protocol).toBeUndefined() // the lead's driver was taught at `create` and is not taught again

    await invoke(['snapshot', 'r1/w-0'])
    expect(last().protocol.driving).toMatch(/Read each one before the next call/)
    await invoke(['snapshot', 'r1/w-0'])
    expect(last().protocol).toBeUndefined()

    // Per actor, not per root: the sibling's driver is a different agent and has been told nothing.
    await invoke(['snapshot', 'r1/w-1'])
    expect(last().protocol.driving).toMatch(/Read each one before the next call/)
  })

  it('teaches a driver whose first move is a bad send, and one that reaches for describe first', async () => {
    // The rule most worth arriving with a rejection is the one about reading responses, so a rejection carries it too.
    await invoke(['create', 'lead'])
    await invoke(['send', 'r1', 'brief.submit', JSON.stringify({ question: 'why?' })])
    await invoke(['send', 'r1/w-0', 'nope', '{}'])
    expect(last()).toMatchObject({ rejected: true, reason: 'unknown-event' })
    expect(last().protocol.driving).toMatch(/Read each one before the next call/)

    await invoke(['describe', 'r1/w-1', 'FINISH'])
    expect(last().protocol.driving).toMatch(/Read each one before the next call/)
    await invoke(['describe', 'r1/w-1', 'FINISH'])
    expect(last().protocol).toBeUndefined()
  })

  it('help, --help, and -h disclose the entry brief exactly like a bare invocation, exit 0', async () => {
    await invoke([])
    const bare = last()
    for (const argv of [['help'], ['--help'], ['-h']]) {
      await invoke(argv)
      expect(last()).toEqual(bare)
      expect(process.exitCode).toBeUndefined()
    }
  })

  it('refuses an unknown command and errors loudly on an unknown actor', async () => {
    // Nothing to fall through to since a project declares no commands, so `search` is simply not a command.
    await invoke(['search', 'foo'])
    expect(last()).toMatchObject({ error: "unknown command 'search'" })
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
    await invoke(['snapshot', 'nope'])
    expect(last()).toEqual({ error: "Unknown actor 'nope'" })
    expect(lastErr()).toBe("Unknown actor 'nope'") // one string, and the braces around it bought nothing
    expect(process.exitCode).toBe(1)
  })
})

describe('trace', () => {
  it('records every call as the agent saw it, in one file per state directory, and leaves the brief unaware of it', async () => {
    await invoke([])
    expect(last().commands.trace).toBeUndefined() // harness-facing, never advertised
    await startRun()
    await invoke(['send', 'r1', 'brief.submit', '{"question":"no"}'])
    process.exitCode = undefined
    await invoke(['search', 'foo'])
    await invoke(['snapshot', 'nope'])
    process.exitCode = undefined

    const trace = readTrace(dir)
    expect(trace.map((e) => [e.argv[0] ?? '', e.actorId ?? '', e.exitCode])).toEqual([
      ['', '', 0],
      ['create', 'r1', 0], // the id the call minted, so the trace can attribute it
      ['send', 'r1', 0],
      ['send', 'r1', 2], // a rejection is recorded with the rejection it printed
      ['search', '', 1], // a usage error touches no actor, and still lands in the same file
      ['snapshot', 'nope', 1], // an error is recorded with the { error } it printed
    ])
    expect(trace[3]!.response).toMatchObject({ rejected: true, reason: 'unknown-event' })
    expect(trace[4]!.response).toMatchObject({ error: "unknown command 'search'" })
    expect(trace[5]!.response).toEqual({ error: "Unknown actor 'nope'" })
    // What drove each send, as the runtime received it: a rejected send records what it tried, and `create` carries none.
    expect(trace[2]!.payload).toEqual({ question: 'why?' })
    expect(trace[3]!.payload).toEqual({ question: 'no' })
    expect(trace[1]).not.toHaveProperty('payload')
    for (const e of trace) expect(e).toMatchObject({ at: expect.any(String), ms: expect.any(Number), pid: process.pid })
  })

  it('records the one actor a send moved, and no other, because no other one can have moved', async () => {
    // What this used to record was the lead being carried to `reviewing` by a *worker's* call, with the lead's own
    // agent never told. That move is now refused at the `on` key that produced it, so `moved` has one
    // subject per call by construction: the actor the call named. It is still harness-only and still absent from the
    // response and from what was printed.
    await startRun()
    await invoke(['send', 'r1/w-0', 'FINISH', '{"note":"x"}'])
    await invoke(['send', 'r1/w-1', 'FINISH', '{"note":"y"}'])
    await invoke(['send', 'r1', 'round.review'])
    const [, , first, second, review] = readTrace(dir)
    expect(first!.moved).toEqual([{ actorId: 'r1/w-0', state: ['done'], steps: [{ from: 'working', event: 'FINISH', to: ['done'] }] }])
    expect(second!.moved).toEqual([{ actorId: 'r1/w-1', state: ['done'], steps: [{ from: 'working', event: 'FINISH', to: ['done'] }] }])
    // The lead moves on its own call, and that call names only the lead.
    expect(review!.moved).toEqual([{ actorId: 'r1', state: ['reviewing'], steps: [{ from: 'working', event: 'round.review', to: ['reviewing'] }] }])
    expect(second!.response).not.toHaveProperty('moved')
    expect(second!.response).not.toHaveProperty('parent')
    expect(out.at(-1)).not.toContain('moved')
  })

})

describe('journey', () => {
  // What a journey needs that the landing state cannot give it: which transition fired. The lead's two
  // transitions on `round.tally` go to the same place or nowhere at all, so their guard is what tells them apart —
  // `at`, the JSON path that used to, died with the JSON it pointed into.
  const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as unknown
  /** A pin session standing in for the one the bin registers, which is process-global and so lives in pin.test.ts. */
  const pinned = (version: string): Partial<CliOptions> => ({ pin: { version: () => version, write: () => {}, has: () => true } })

  it('tells two transitions on one event apart by their guard, the record carrying facts rather than pointers', async () => {
    await invoke(['create', 'lead'])
    await invoke(['send', 'r1', 'brief.submit', JSON.stringify({ question: 'why?' })])
    await invoke(['send', 'r1', 'round.tally'])
    await invoke(['send', 'r1', 'round.tally'])

    const trace = readTrace(dir)
    const leadOn = (n: number) => trace[n]!.moved!.find((m) => m.actorId === 'r1')!
    // The same event, the same actor, the same landing state twice over. The one that moved nowhere is separated by
    // having no `to` at all; the one that moved is separated by the guard that let it.
    expect(leadOn(2).steps).toEqual([{ from: 'working', event: 'round.tally' }])
    expect(leadOn(3).steps).toEqual([{ from: 'working', event: 'round.tally', guard: 'tallied', to: ['briefing'] }])
    // No step points anywhere: there is no document left to point into.
    for (const entry of trace) for (const moved of entry.moved ?? []) for (const step of moved.steps ?? []) expect(step).not.toHaveProperty('at')
  })

  it('records the version once on the root, not on every line, and keeps no copy of the code', async () => {
    await invoke(['create', 'lead'], pinned('cafebabe1234'))
    await invoke(['send', 'r1', 'brief.submit', JSON.stringify({ question: 'why?' })], pinned('cafebabe1234'))

    // Under a pin every line of a run ran the same code by construction, so `Moved` stopped carrying a version.
    for (const entry of readTrace(dir)) for (const moved of entry.moved ?? []) expect(moved).not.toHaveProperty('definition')
    expect(read(join(dir, 'r1.json'))).toMatchObject({ version: 'cafebabe1234' })
    // The run keeps no readable copy of the definitions it ran: `definitions/<hash>.json` died with zero readers.
    expect(existsSync(join(dir, 'definitions'))).toBe(false)
  })

  it('records which bin created the root', async () => {
    // A run's report spells its commands with the bin that drove it. Telling two projects apart is the catalog's job
    // (`refuseForeign` in `cli/agent.ts`), since every project's tool is taught under the one name.
    await invoke(['create', 'lead'])
    expect(read(join(dir, 'r1.json'))).toMatchObject({ bin: 'test' })
  })

  it('keeps the version across later calls, which rewrite the record without pinning anything themselves', async () => {
    await invoke(['create', 'lead'], pinned('feedface5678'))
    // A serving call knows the version from the pin it read; a call with no pin at all must not erase it.
    await invoke(['send', 'r1', 'brief.submit', JSON.stringify({ question: 'why?' })], { pin: noPin() })
    expect(read(join(dir, 'r1.json'))).toMatchObject({ version: 'feedface5678' })
  })

  it('records a state passed straight through, which no landing state can show', async () => {
    // Nobody ever rests in `checking`: it decides and moves on inside the same call, so it appears in no summary and
    // could not appear in the trace at all. This is also the canary for the one private thing this rests on — the
    // transitions ride on a microstep's `_transitions`, and if an XState upgrade stops carrying them this fails here
    // rather than quietly emptying every journey.
    const gate = setup({
      types: { context: {} as { agent: AgentTrackingContext; ok: boolean }, events: {} as AgentTrackingEvent | { type: 'submit'; ok: boolean }, meta: {} as AgentMeta },
      guards: { accepted: ({ context }) => context.ok },
    }).createMachine({
      id: 'gate',
      description: 'Checks a submission and moves straight on.',
      context: { ...agentTracking.context, ok: false },
      on: { ...agentTracking.on },
      initial: 'awaiting',
      states: {
        // The schema rides the transition, not the state: a schema on a state nothing targets can never be presented.
        awaiting: {
          description: 'Nothing submitted yet.',
          on: { submit: { target: 'checking', meta: { schema: z.object({ ok: z.boolean() }) }, actions: assign({ ok: ({ event }) => (event as { ok: boolean }).ok }) } },
        },
        checking: { description: 'Deciding, without stopping.', always: [{ guard: 'accepted', target: 'accepted' }, { target: 'rejected' }] },
        accepted: { type: 'final', description: 'Accepted.' },
        rejected: { description: 'Rejected.', on: { submit: 'checking' } },
      },
    })
    const drive = (argv: string[]) => invoke(argv, { machines: { gate } })

    await drive(['create', 'gate'])
    await drive(['send', 'r1', 'submit', '{"ok":true}'])
    expect(last().state).toEqual([{ id: 'accepted' }])
    // The step through `checking` is the whole record that the guard was ever consulted.
    expect(readTrace(dir).at(-1)!.moved).toEqual([
      {
        actorId: 'r1',
        state: ['accepted'],
        steps: [
          { from: 'awaiting', event: 'submit', to: ['checking'] },
          { from: 'checking', event: 'always', guard: 'accepted', to: ['accepted'] },
        ],
      },
    ])
  })

  it('passes over a file in the run that is not a root actor record, the pin included', async () => {
    await startRun()
    writeFileSync(join(dir, 'stray.json'), '{"not":"a record"}')
    writeFileSync(join(dir, 'broken.json'), '{oops')
    // ADR-0006's amendment asked that the next thing written into a run not break `report` the way a version copy
    // would have. The pin is that next thing, and it sits at the top level where root records live.
    writeFileSync(pinPath(dir, 'r1'), JSON.stringify({ resolved: {}, modules: {} }))
    expect(listRuns(pinnedLocator(dir))[0]!.roots.map((root) => root.id)).toEqual(['r1'])
  })
})

describe('runs', () => {
  // No pin: each root is its own run directory under live, and the runtime moves it when the root finishes
  // (ADR-0006). What these lock is that the trace lands before the move, so a report of a completed run has its last
  // call, and that a read of the output still finds the root afterwards — the moment a person asks — while adding
  // nothing to the run it is reading, since that read is no longer a call.
  let runs: RunsDirs
  beforeEach(() => {
    runs = { live: join(dir, 'live'), completed: join(dir, 'completed') }
  })
  const unpinned = (argv: string[]) => invoke(argv, { stateDir: undefined, runs })

  it('gives each root actor its own run under live and moves it to completed when the root finishes', async () => {
    await unpinned(['create', 'lead'])
    expect(existsSync(join(runs.live, 'r1', 'r1.json'))).toBe(true)
    await unpinned(['send', 'r1', 'brief.submit', JSON.stringify({ question: 'why?' })])
    await unpinned(['send', 'r1/w-0', 'FINISH', '{"note":"x"}'])
    await unpinned(['send', 'r1/w-1', 'FINISH', '{"note":"y"}'])
    await unpinned(['send', 'r1', 'round.review'])
    expect(existsSync(join(runs.live, 'r1'))).toBe(true) // reviewing: still live
    await unpinned(['send', 'r1', 'finish'])
    // The call that finished the run traced before the move, so the response is read from where the run now is.
    expect(last(join(runs.completed, 'r1')).status).toBe('done')
    expect(existsSync(join(runs.live, 'r1'))).toBe(false)
    expect(existsSync(join(runs.completed, 'r1', 'r1.json'))).toBe(true)
    const trace = readTrace(join(runs.completed, 'r1'))
    expect(trace.map((e) => e.argv.slice(0, 2))).toEqual([['create', 'lead'], ['send', 'r1'], ['send', 'r1/w-0'], ['send', 'r1/w-1'], ['send', 'r1'], ['send', 'r1']])
    expect(await outputOf(fileStore(runsLocator(runs).dirOf), 'r1')).toEqual({ actorId: 'r1', status: 'done', output: { report: 'answer to why?' } })
    expect(readTrace(join(runs.completed, 'r1'))).toHaveLength(6) // six calls made the run; the read is not a seventh
    expect(listRuns(runsLocator(runs))).toMatchObject([{ where: 'completed', calls: 6, roots: [{ id: 'r1', machine: 'lead', status: 'done' }] }])
  })

  it('traces a call that touches no actor, or an actor no run holds, in the run-less file beside the runs', async () => {
    await unpinned([])
    await unpinned(['snapshot', 'nope'])
    expect(last(runs.live)).toEqual({ error: "Unknown actor 'nope'" })
    expect(existsSync(join(runs.live, 'nope'))).toBe(false) // an unknown id must not mint a run
    expect(readTrace(runs.live).map((e) => e.argv[0] ?? '')).toEqual(['', 'snapshot'])
    process.exitCode = undefined
  })

  it('refuses a machine name inherited from Object as unknown, before minting a run', async () => {
    // `name in machines` found `constructor` on the prototype, so the run and its scratch were made before the
    // registry failed on a machine it never registered, and both were left behind.
    await unpinned(['create', 'constructor'])
    expect(last(runs.live)).toEqual({ error: "Unknown machine 'constructor'" })
    expect(existsSync(join(runs.live, 'r1'))).toBe(false)
    expect(existsSync(scratchDir('r1'))).toBe(false)
    process.exitCode = undefined
  })

  it('never moves a pinned run, however many roots it holds', async () => {
    await startRun()
    await invoke(['send', 'r1/w-0', 'FINISH', '{"note":"x"}'])
    await invoke(['send', 'r1/w-1', 'FINISH', '{"note":"y"}'])
    await invoke(['send', 'r1', 'round.review'])
    await invoke(['send', 'r1', 'finish'])
    await invoke(['create', 'lead'])
    expect(existsSync(join(dir, 'r1.json'))).toBe(true)
    expect(listRuns(pinnedLocator(dir))).toMatchObject([{ where: 'pinned', roots: [{ id: 'r1', status: 'done' }, { id: 'r2', status: 'active' }] }])
  })

  it('keeps each root in a pinned run on the code it started with, however many roots share it', async () => {
    // A harness may create several roots in one pinned directory with an edit between them. Each root has to keep
    // being served the code its own `create` captured, and one finishing must not drop another back onto the edit.
    const capturing = (code: string): Partial<CliOptions> => ({
      pin: { version: () => code, has: () => true, write: (at, rootId) => writeFileSync(pinPath(at, rootId), JSON.stringify({ resolved: {}, modules: { 'file:///m.ts': { format: 'module', source: code } } })) },
    })
    const servedTo = (rootId: string) => readPin(dir, rootId)?.modules['file:///m.ts']?.source
    await invoke(['create', 'lead'], capturing('ORIGINAL'))
    await invoke(['create', 'lead'], capturing('EDITED'))
    expect(servedTo('r1')).toBe('ORIGINAL')
    expect(servedTo('r2')).toBe('EDITED')

    await invoke(['send', 'r1', 'brief.submit', JSON.stringify({ question: 'why?' })])
    await invoke(['send', 'r1/w-0', 'FINISH', '{"note":"x"}'])
    await invoke(['send', 'r1/w-1', 'FINISH', '{"note":"y"}'])
    await invoke(['send', 'r1', 'round.review'])
    await invoke(['send', 'r1', 'finish'])
    expect(servedTo('r1')).toBeUndefined() // finished: shed, and a later call runs the current code
    expect(servedTo('r2')).toBe('EDITED')
  })
})

describe('where a run\'s data lives by default', () => {
  // Runs hold full payloads and source, and a temp directory may be shared: the default must be this user's alone.
  it('is a directory only this user can enter, named for the user so a shared temp dir cannot be claimed first', () => {
    const scratch = scratchDir('r1')
    const base = dirname(dirname(scratch))
    expect(basename(base)).toBe(`backseat-${process.getuid!()}`)
    expect(statSync(base).mode & 0o777).toBe(0o700)
    expect(runsDirs(join(base, 'no-config.json')).completed).toBe(join(base, 'runs'))
  })
})

describe('a machine\'s implementations', () => {
  // A machine whose implementations ask which run they are in, refuse an event, or throw: what they need from the bin
  // is the run's directory before the first step, a refusal that unwinds instead of erroring the actor, and a throw
  // that errors the actor instead of crashing the process.
  const seen: Array<{ id: string; dir: string }> = []
  const implemented = setup({
    types: {
      context: {} as { agent: AgentTrackingContext },
      events: {} as AgentTrackingEvent | { type: 'write' } | { type: 'refuse' } | { type: 'boom' } | { type: 'finish' },
      meta: {} as AgentMeta,
    },
    actions: {
      note: () => {
        seen.push(currentRun())
      },
      refuse: () => {
        throw new RejectedEvent('finding.md already exists; send again with "overwrite": true')
      },
      boom: () => {
        throw new Error('disk on fire')
      },
    },
  }).createMachine({
    id: 'implemented',
    description: 'Has implementations.',
    context: { ...agentTracking.context },
    on: { ...agentTracking.on },
    initial: 'a',
    states: {
      a: { description: 'A.', entry: 'note', on: { write: { actions: 'note' }, refuse: { target: 'b', actions: 'refuse' }, boom: { actions: 'boom' }, finish: 'b' } },
      b: { type: 'final', description: 'B.' },
    },
  })
  const call = (argv: string[]) => invoke(argv, { machines: { implemented } })
  beforeEach(() => {
    seen.length = 0
    setCurrentRun(undefined)
  })

  it('has the run in place before the root starts, so an entry action already knows it', async () => {
    await call(['create', 'implemented'])
    expect(seen).toEqual([{ id: 'r1', dir }])
  })

  it('has a scratch directory beside the run, not inside it, and names it on the record', async () => {
    await call(['create', 'implemented'])
    const scratch = scratchDir('r1')
    expect(existsSync(scratch)).toBe(true)
    // The point: what a machine writes for another agent to read is a courier, so it must not be filed in the
    // run, which is the record. Nothing under the run directory, at any depth, is the scratch.
    expect(scratch.startsWith(dir)).toBe(false)
    // Recorded because `tmpdir()` varies by platform and environment: an assessor reads the path, never derives it.
    expect((await fileStore(() => dir).get('r1'))?.scratch).toBe(scratch)
  })

  it('sheds the scratch directory when the root finishes, and keeps the record and the trace', async () => {
    await call(['create', 'implemented'])
    writeFileSync(join(scratchDir('r1'), 'finding.md'), 'What was found.')
    await call(['send', 'r1', 'finish'])
    // A courier is meant to be lost. The run ended, so the hand-off file is gone with the directory that held it —
    // and nothing anywhere lists what it was, by the same reasoning that deleted `index.json`.
    expect(existsSync(scratchDir('r1'))).toBe(false)
    const record = await fileStore(() => dir).get('r1')
    expect(record?.snapshot.status).toBe('done')
    // The path stays on the record of a finished run: it says where the couriers went, not that they are still there.
    expect(record?.scratch).toBe(scratchDir('r1'))
    expect(readTrace(dir).map((entry) => entry.argv[0])).toEqual(['create', 'send'])
  })

  it('an implementation that refuses the event leaves the actor where it was, exit 2, with the message', async () => {
    await call(['create', 'implemented'])
    await call(['send', 'r1', 'refuse'])
    expect(last()).toMatchObject({ rejected: true, reason: 'refused', message: 'finding.md already exists; send again with "overwrite": true', status: 'active', state: [{ id: 'a' }] })
    expect(process.exitCode).toBe(2)
    process.exitCode = undefined
    await call(['snapshot', 'r1'])
    expect(last()).toMatchObject({ status: 'active', state: [{ id: 'a' }] })
  })

  it('any other throw errors the actor and ends the run, instead of crashing the process', async () => {
    await call(['create', 'implemented'])
    await call(['send', 'r1', 'boom'])
    expect(last()).toMatchObject({ status: 'error', error: 'disk on fire' })
    // Exit 0 on purpose, as `done` is: the send moved the actor, into a final status. Only a later send is refused.
    // `docs/driving.md`'s exit table says so.
    expect(process.exitCode).toBeUndefined()
    await call(['send', 'r1', 'boom'])
    expect(process.exitCode).toBe(2)
    expect(last()).toMatchObject({ rejected: true, reason: 'actor-error' })
  })
})

describe('spawn sites', () => {
  // A lead that fans out from one state, pulls the next task when a worker finishes (deep-research's dispatchNext,
  // spawning from a done event), and reviews only once every worker from that site is settled (ADR-0008). Hand-built
  // with the `meta` the compiler would carry: `sites` on the state, `settled` on the transition.
  const fanout = setup({
    actors: { worker },
    types: {
      context: {} as { agent: AgentTrackingContext; queue: string[]; n: number },
      events: {} as AgentTrackingEvent | { type: 'round.more' } | { type: 'round.review' } | { type: 'finish' },
      meta: {} as AgentMeta,
    },
    guards: { hasMore: ({ context }) => context.queue.length > 0 },
  }).createMachine({
    id: 'fanout',
    description: 'Fans out.',
    context: { ...agentTracking.context, queue: ['c'], n: 0 },
    on: { ...agentTracking.on },
    initial: 'dispatching',
    states: {
      dispatching: {
        description: 'Workers are out.',
        meta: { sites: [{ src: 'worker' }] },
        entry: assign({
          n: ({ spawn }) => {
            spawn('worker', { id: 'w-0', input: { q: 'a' } })
            spawn('worker', { id: 'w-1', input: { q: 'b' } })
            return 2
          },
        }),
        on: {
          // Another worker joins the round on the lead's own send, never on a child finishing. The spawn is
          // still made from inside an action body, which is the point: lowering cannot see it, so the child is filed
          // from the state the call started from rather than from a declared site.
          'round.more': {
            guard: 'hasMore',
            actions: assign({
              queue: ({ context, spawn }) => {
                const [q, ...rest] = context.queue
                spawn('worker', { id: `w-${context.n}`, input: { q: q! } })
                return rest
              },
              n: ({ context }) => context.n + 1,
            }),
          },
          'round.review': { target: 'reviewing', meta: { settled: [{ state: 'dispatching', src: 'worker' }] } },
        },
      },
      reviewing: { description: 'All workers back.', on: { finish: 'complete' } },
      complete: { type: 'final', description: 'Done.' },
    },
  })
  const fan = (argv: string[], extra: Partial<CliOptions> = {}) => invoke(argv, { machines: { fanout }, ...extra })
  const record = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { sites?: unknown }

  it('refuses a settled transition while a child of the site is pending, naming them, and takes it once they are gone', async () => {
    await fan(['create', 'fanout'])
    expect(last().children.map((c: { id: string }) => c.id)).toEqual(['r1/w-0', 'r1/w-1'])
    // Not offered yet, so not shown (ADR-0008): a driver that sees a move listed reads it as on offer and sends it into
    // the refusal below.
    await fan(['snapshot', 'r1'])
    const listed = (r: any) => r.targets.flatMap((t: { events: Array<{ type: string }> }) => t.events).map((e: { type: string }) => e.type)
    expect(listed(last())).not.toContain('round.review')
    await fan(['describe', 'r1', 'round.review'])
    // The refusal is in the agent's frame: the subagents not yet finished, by id, and nothing about the site or
    // the machine, which the agent knows neither of as a thing. Both stay on the structured `pending` for the trace.
    expect(last()).toMatchObject({ rejected: true, reason: 'pending-children', message: 'these subagents have not finished their workflows: r1/w-0, r1/w-1. round.review is offered once they have.' })
    process.exitCode = undefined

    await fan(['send', 'r1', 'round.review'])
    expect(last()).toMatchObject({
      rejected: true,
      reason: 'pending-children',
      pending: [{ state: 'dispatching', src: 'worker', children: ['r1/w-0', 'r1/w-1'] }],
      message: 'these subagents have not finished their workflows: r1/w-0, r1/w-1. Send round.review again once they have.',
      state: [{ id: 'dispatching' }],
    })
    expect(process.exitCode).toBe(2)
    process.exitCode = undefined

    // The lead adds w-2 on its own send, from inside an action body no site declares: it is filed from the state the
    // call started in and collected like any other, and nothing is warned.
    await fan(['send', 'r1/w-0', 'FINISH', '{"note":"x"}'])
    await fan(['send', 'r1', 'round.more'])
    expect(readTrace(dir).at(-1)).not.toHaveProperty('warnings')
    await fan(['send', 'r1', 'round.review'])
    expect(last().pending).toEqual([{ state: 'dispatching', src: 'worker', children: ['r1/w-1', 'r1/w-2'] }])
    process.exitCode = undefined

    await fan(['send', 'r1/w-1', 'FINISH', '{"note":"y"}'])
    await fan(['send', 'r1/w-2', 'FINISH', '{"note":"z"}'])
    // Every child settled: now it is offered, and listed with what it collects.
    await fan(['snapshot', 'r1'])
    expect(listed(last())).toContain('round.review')
    await fan(['send', 'r1', 'round.review'])
    expect(last()).toMatchObject({ status: 'active', state: [{ id: 'reviewing' }] })
    expect(process.exitCode).toBeUndefined()
    // Every invocation above rehydrated the root from its file, so the site record was read back each time it was consulted.
    // No `about` anywhere in this fixture — it is plain XState — so each child is recorded with the input it was resolved with.
    expect(record(join(dir, 'r1.json')).sites).toEqual({
      // Collected, not cleared: the entries stay so a later spawn at the site can tell one round's workers from the
      // next's, and it is that next spawn which drops them (ADR-0008).
      r1: {
        'w-0': { state: 'dispatching', src: 'worker', collected: true, about: { q: 'a' } },
        'w-1': { state: 'dispatching', src: 'worker', collected: true, about: { q: 'b' } },
        'w-2': { state: 'dispatching', src: 'worker', collected: true, about: { q: 'c' } },
      },
    })
    expect(readTrace(dir).every((e) => e.warnings === undefined)).toBe(true)
  })

  it('files a child spawned from inside an action under the state the call started from, so it can still be collected', async () => {
    const sneaky = setup({
      actors: { worker },
      types: { context: {} as { agent: AgentTrackingContext }, events: {} as AgentTrackingEvent | { type: 'finish' }, meta: {} as AgentMeta },
    }).createMachine({
      id: 'sneaky',
      description: 'Spawns from code with no site declared.',
      context: { ...agentTracking.context },
      on: { ...agentTracking.on },
      initial: 'a',
      states: {
        a: { description: 'A.', entry: assign({ agent: ({ context, spawn }) => (spawn('worker', { id: 'w-0', input: { q: 'a' } }), context.agent) }), on: { finish: 'b' } },
        b: { type: 'final', description: 'B.' },
      },
    })
    await invoke(['create', 'sneaky'], { machines: { sneaky } })
    expect(last()).not.toHaveProperty('warnings')
    expect(readTrace(dir).at(-1)?.warnings).toBeUndefined()
    // Nothing declared this site — the spawn is inside an `assign` — but the child's own src and the state the call
    // started from are between them the site, so it is filed like any other and a `collect` can take it.
    expect(record(join(dir, 'r1.json')).sites).toEqual({ r1: { 'w-0': { state: 'a', src: 'worker', about: { q: 'a' } } } })
    expect(listRuns(pinnedLocator(dir))).toMatchObject([{ undeclared: 0 }])
  })

  it('keeps the site record with the run when the run moves', async () => {
    const runs: RunsDirs = { live: join(dir, 'live'), completed: join(dir, 'completed') }
    const unpinned = (argv: string[]) => fan(argv, { stateDir: undefined, runs })
    await unpinned(['create', 'fanout'])
    await unpinned(['send', 'r1', 'round.more'])
    for (const w of ['w-0', 'w-1', 'w-2']) await unpinned(['send', `r1/${w}`, 'FINISH', '{"note":"x"}'])
    await unpinned(['send', 'r1', 'round.review'])
    await unpinned(['send', 'r1', 'finish'])
    // The call that finished the run traced before the move, so the response is read from where the run now is.
    expect(last(join(runs.completed, 'r1')).status).toBe('done')
    expect(record(join(runs.completed, 'r1', 'r1.json')).sites).toMatchObject({ r1: { 'w-2': { state: 'dispatching', src: 'worker' } } })
  })
})

describe('a transition that runs the tool it guards', () => {
  it('traces what the effect returned in full, beside the response that showed only what data chose to', async () => {
    const machines = { looker }
    await invoke(['create', 'looker'], { machines })
    await invoke(['send', 'r1', 'look', JSON.stringify({ id: 'x1' })], { machines })
    const entry = readTrace(dir).at(-1)!
    expect(entry.effect).toEqual({ output: { id: 'x1', title: 'Title of x1', body: 'the whole of it' } })
    expect((entry.response as { data: unknown }).data).toEqual({ found: 'Title of x1' })
    // The effect refused: nothing ran to completion, so there is nothing to trace, and the call is still traced.
    await invoke(['send', 'r1', 'look', JSON.stringify({ id: 'missing' })], { machines })
    const refused = readTrace(dir).at(-1)!
    expect(refused.effect).toBeUndefined()
    expect(refused.exitCode).toBe(2)
    expect((refused.response as { reason: string; message: string })).toMatchObject({ reason: 'refused', message: 'Nothing by that id.' })
  })
})
