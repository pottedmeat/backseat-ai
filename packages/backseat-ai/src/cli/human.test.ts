import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commands, run, usage } from './human.js'
import { scratchDir } from '../runtime/index.js'

/**
 * `output`, `report` and `doctor` run against runs each test writes into a disposable home laid out the way ADR-0006 says runs live: a config
 * pointing at `live/` and `completed/` beside it, a directory per run, and in it each root's record and the trace of
 * the run's calls. Nothing recorded is kept in the repo.
 */
type Root = { id: string; status: 'active' | 'done'; output?: unknown; collected?: Record<string, Record<string, unknown>> }

/** A home whose config names the two runs directories beside it, the way `runsDirs` resolves them. */
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'backseat-home-'))
  mkdirSync(join(home, 'backseat'), { recursive: true })
  writeFileSync(join(home, 'backseat', 'config.json'), JSON.stringify({ runs: { live: join(home, 'live'), completed: join(home, 'completed') } }))
  return home
}

/**
 * One run: a record per root, and a trace with one `create` per root at `at`, which is the run's whole age. The
 * records say which bin created them, the way a run's own do.
 */
function writeRun(dir: string, at: string, roots: Root[]): string {
  mkdirSync(dir, { recursive: true })
  for (const { id, status, output, collected } of roots) {
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ machine: 'lead', snapshot: { status, output }, collected, bin: 'research' }))
  }
  const entries = roots.map(({ id }) => ({ at, ms: 0, pid: 1, argv: ['create', 'lead'], actorId: id, exitCode: 0, response: {} }))
  writeFileSync(join(dir, 'trace.jsonl'), entries.map((entry) => JSON.stringify(entry) + '\n').join(''))
  return dir
}

describe('the backseat-ai bin', () => {
  let out: string[]
  let err: string[]

  beforeEach(() => {
    out = []
    err = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (out.push(String(chunk)), true))
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (err.push(String(chunk)), true))
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it('prints the command reference with no arguments, and succeeds', async () => {
    await run([])
    expect(out.join('')).toContain('npx backseat-ai <command>')
    expect(process.exitCode).toBeUndefined()
  })

  it('never teaches the bare name, because `npx backseat` runs a stranger’s package', async () => {
    await run([])
    expect(out.join('')).not.toMatch(/(?<![-\w])backseat <|npx backseat(?!-ai)/)
  })

  it('refuses a mistyped flag rather than running the command without it', async () => {
    // `doctor --yse` must not read as `doctor`: ignoring it would look like a removal that was asked for and not done.
    await run(['doctor', '--yse'])
    expect(err.join('')).toContain("backseat-ai doctor: unknown flag '--yse'")
    expect(process.exitCode).toBe(1)
  })

  it('prints the version the package is', async () => {
    await run(['--version'])
    expect(out.join('')).toMatch(/^\d+\.\d+\.\d+/)
    expect(process.exitCode).toBeUndefined()
  })

  it('points a human at the project’s cli.ts for everything that reads machines, which is deliberately not on this bin', async () => {
    // The bin runs as whatever copy npx or a global install has; a catalog read by that copy is not the Backseat that
    // built it. So nothing that imports a catalog may come back here.
    expect(usage()).toContain('`node cli.ts --drive`')
    for (const readsACatalog of ['create', 'send', 'snapshot', 'describe', 'lint', 'stately']) {
      expect(commands).not.toHaveProperty(readsACatalog)
    }
    await run(['lint'])
    expect(process.exitCode).toBe(1)
    expect(err.join('')).toContain("unknown command 'lint'")
    // A person who typed a project command here is told where it lives, not just handed the bin's table.
    expect(err.join('')).toContain("'lint' reads a project's machines: `node cli.ts lint`")
  })

  it('does not take a name every object inherits for a command', async () => {
    // `constructor` is on the table's prototype, and it is not something this tool can run.
    await run(['constructor'])
    expect(process.exitCode).toBe(1)
    expect(err.join('')).toContain("unknown command 'constructor'")
  })

  it('fails an unknown command rather than falling through to usage alone', async () => {
    await run(['bogus'])
    expect(process.exitCode).toBe(1)
    expect(err.join('')).toContain("unknown command 'bogus'")
    expect(err.join('')).not.toContain("'bogus' reads")
  })

  describe('report', () => {
    // The table is what a human picks from, so it must show every run in every place — and a pinned run with two
    // leads as two rows — with each root's last word. Rendering by prefix and by path is how a script or a second
    // look gets straight to one run.
    const STUCK = 'aaaa1111-0000-4000-8000-000000000001'
    const RESCUE = 'bbbb2222-0000-4000-8000-000000000002'
    const DONE = 'cccc3333-0000-4000-8000-000000000003'
    const OPEN = 'dddd4444-0000-4000-8000-000000000004'
    let home: string
    let pinned: string
    let env: Record<string, string | undefined>
    beforeEach(() => {
      home = makeHome()
      // Three runs, newest first: the pinned one holds a lead that deadlocked and the lead started to rescue it.
      pinned = writeRun(join(home, 'pinned'), '2026-09-08T00:00:00.000Z', [
        { id: STUCK, status: 'active' },
        { id: RESCUE, status: 'done' },
      ])
      writeRun(join(home, 'completed', DONE), '2026-09-07T00:00:00.000Z', [{ id: DONE, status: 'done' }])
      writeRun(join(home, 'live', OPEN), '2026-09-06T00:00:00.000Z', [{ id: OPEN, status: 'active' }])
      env = { XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'], BACKSEAT_STATE_DIR: process.env['BACKSEAT_STATE_DIR'] }
      process.env['XDG_CONFIG_HOME'] = home
      process.env['BACKSEAT_STATE_DIR'] = pinned
      vi.spyOn(process, 'stdin', 'get').mockReturnValue({ isTTY: false } as unknown as typeof process.stdin)
    })
    afterEach(() => {
      for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v)
      rmSync(home, { recursive: true, force: true })
    })

    it('lists live, completed and pinned runs newest first, one row per root, and just lists when stdin is not a terminal', async () => {
      await run(['report'])
      expect(process.exitCode).toBeUndefined()
      const lines = out.join('').split('\n')
      expect(lines[0]).toMatch(/^#\s+machine\s+root\s+status\s+started\s+last call\s+calls\s+undeclared\s+where/)
      expect(lines.slice(1, 5).map((l) => l.split(/\s{2,}/).slice(0, 4))).toEqual([
        ['1', 'lead', STUCK.slice(0, 8), 'not finished'], // the pinned run's stuck lead
        ['', 'lead', RESCUE.slice(0, 8), 'done'], // and its rescue, in the same pinned run
        ['2', 'lead', DONE.slice(0, 8), 'done'],
        ['3', 'lead', OPEN.slice(0, 8), 'not finished'],
      ])
      expect(lines[1]).toContain('pinned')
      expect(lines[3]).toMatch(/\bcompleted$/)
      expect(lines[4]).toMatch(/\blive$/)
    })

    it('renders one run by root id prefix, writing the page beside the run, naming the bin that drove it', async () => {
      await run(['report', RESCUE.slice(0, 4), '--no-open'])
      expect(process.exitCode).toBeUndefined()
      const path = join(pinned, 'trace.html')
      expect(out.join('')).toContain(`${path} (2 calls)`)
      const page = readFileSync(path, 'utf8')
      // Each project has its own bin, so the page renders the run's calls as that bin's command lines, from its records.
      expect(page).toContain('"bin":"research"')
      expect(page).not.toContain('fonts.googleapis.com') // no network: a report opens offline
    })

    it('renders any directory holding a trace, and fails an ambiguous or unknown prefix', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'backseat-report-'))
      try {
        await run(['report', dir, '--no-open'])
        expect(existsSync(join(dir, 'trace.html'))).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
      await run(['report', 'zzz', '--no-open'])
      expect(process.exitCode).toBe(1)
      expect(err.join('')).toContain("no run whose root id starts with 'zzz'")
    })
  })

  /**
   * A lead that finished with its drafted report, and a worker the gate collected and stopped. Those two are the
   * whole of what `output` has to reach — a root's own `snapshot.output`, and the copy ADR-0008 keeps of a child
   * that is gone from the persisted `children` map — so the run holds both.
   */
  describe('output', () => {
    const LEAD = 'd6f4ca7e-0000-4000-8000-000000000005'
    let home: string
    let run3: string
    let env: Record<string, string | undefined>
    beforeEach(() => {
      home = makeHome()
      run3 = writeRun(join(home, 'pinned'), '2026-09-08T00:00:00.000Z', [
        {
          id: LEAD,
          status: 'done',
          output: { report: 'What was found.', citations: [] },
          collected: { [LEAD]: { 'task-1-0': { status: 'done', output: { subQuestion: 'What is the first thing?' } } } },
        },
      ])
      // A prefix is expanded against every run the tool can find, so the configured runs are pinned at the home
      // too: left at this machine's own, the scan would be whatever happens to be lying around.
      env = { XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'], BACKSEAT_STATE_DIR: process.env['BACKSEAT_STATE_DIR'] }
      process.env['XDG_CONFIG_HOME'] = home
      process.env['BACKSEAT_STATE_DIR'] = run3
    })
    afterEach(() => {
      for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v)
      rmSync(home, { recursive: true, force: true })
    })

    it('prints the finished lead’s output, by a prefix of its root id', async () => {
      await run(['output', LEAD.slice(0, 4)])
      expect(process.exitCode).toBeUndefined()
      const printed = JSON.parse(out.join(''))
      expect(printed.actorId).toBe(LEAD)
      expect(printed.status).toBe('done')
      expect(Object.keys(printed.output)).toEqual(['report', 'citations'])
    })

    it('falls back to the preserved record for a collected child', async () => {
      await run(['output', `${LEAD}/task-1-0`])
      expect(process.exitCode).toBeUndefined()
      const printed = JSON.parse(out.join(''))
      expect(printed).toMatchObject({ actorId: `${LEAD}/task-1-0`, status: 'done' })
      expect(printed.output.subQuestion).toEqual(expect.any(String))
    })

    // Reading a run must leave no mark on it: a person's look is not a call the run made. The trace and the
    // record are what a live run is assessed from, and a report that counted this read would be counting the assessor.
    it('leaves the run untouched: no trace line, no lock, nothing written', async () => {
      const before = readdirSync(run3).map((name) => [name, statSync(join(run3, name)).mtimeMs])
      await run(['output', LEAD])
      expect(readdirSync(run3).map((name) => [name, statSync(join(run3, name)).mtimeMs])).toEqual(before)
    })

    it('says which actor it cannot find, and refuses an ambiguous prefix', async () => {
      await run(['output', 'zzzz'])
      expect(process.exitCode).toBe(1)
      expect(err.join('')).toContain("no run whose root id starts with 'zzzz'")
      process.exitCode = undefined

      await run(['output', `${LEAD}/nobody`])
      expect(process.exitCode).toBe(1)
      expect(err.join('')).toContain(`Unknown actor '${LEAD}/nobody'`)
    })
  })

  /**
   * A finding has to explain itself: the person reading it is looking at a terminal, and a rule named only by a number
   * or a pointer to a document is one they will not follow. So each finding carries the rule's id, title and why.
   * The catalog is the one a project's `cli.ts` names.
   */
  describe('lint', () => {
    let project: string
    beforeEach(() => {
      project = mkdtempSync(join(tmpdir(), 'backseat-lint-'))
      const compiler = resolve(import.meta.dirname, '..', 'compiler', 'index.ts')
      writeFileSync(
        join(project, 'machines.ts'),
        `import { backseat } from ${JSON.stringify(compiler)}
export default {
  silent: backseat().createMachine({
    id: 'silent',
    description: 'A machine whose ending says nothing.',
    initial: 'start',
    states: {
      start: { description: 'The beginning.', instructions: 'Send go.', on: { go: { target: 'done', description: 'Finish.' } } },
      done: { type: 'final', description: 'Finished.' },
    },
  }),
}
`,
      )
    })
    afterEach(() => rmSync(project, { recursive: true, force: true }))

    it('prints each finding with the id, title and why of its rule, and points at no document', async () => {
      await run(['lint'], pathToFileURL(join(project, 'machines.ts')))
      const printed = out.join('')
      expect(printed).toContain('done\n    is a final state with no instructions')
      expect(printed).toContain("spend-the-last-word: A final state's instructions are the last thing the agent reads")
      expect(printed).toContain('Arriving at a final state delivers its instructions and closes the actor')
      expect(printed).not.toMatch(/\.md\b|rule \d/)
      expect(process.exitCode).toBe(1) // a finding fails the run, so a script can gate on it
    })

    it('refuses a name the catalog lacks, even beside one it holds', async () => {
      // Skipped quietly, a typo reads as a clean lint of a machine that was never looked at.
      await run(['lint', 'silent', 'bogus'], pathToFileURL(join(project, 'machines.ts')))
      expect(err.join('')).toContain('no machine named bogus; the catalog holds silent')
      expect(out.join('')).toBe('')
      expect(process.exitCode).toBe(1)
    })
  })

  /**
   * One file per catalog machine, named for the machine, so a person pastes the one they want. What goes in the file
   * is `stately.test.ts`'s; this pins the command around it.
   */
  describe('stately', () => {
    let project: string
    beforeEach(() => {
      project = mkdtempSync(join(tmpdir(), 'backseat-stately-'))
      const compiler = resolve(import.meta.dirname, '..', 'compiler', 'index.ts')
      writeFileSync(
        join(project, 'machines.ts'),
        `import { backseat } from ${JSON.stringify(compiler)}
export default {
  short: backseat().createMachine({
    id: 'short',
    description: 'A machine with one move.',
    initial: 'start',
    states: {
      start: { description: 'The beginning.', instructions: 'Send go.', on: { go: { target: 'done', description: 'Finish.' } } },
      done: { type: 'final', description: 'Finished.', instructions: 'Nothing is left to do.' },
    },
  }),
}
`,
      )
    })
    afterEach(() => rmSync(project, { recursive: true, force: true }))

    it('writes <name>.stately.ts for each catalog machine and prints where', async () => {
      const outDir = join(project, 'out')
      await run(['stately', '--out', outDir], pathToFileURL(join(project, 'machines.ts')))
      expect(process.exitCode).toBeUndefined()
      const written = join(outDir, 'short.stately.ts')
      expect(out.join('')).toBe(`${written}\n`)
      expect(readFileSync(written, 'utf8')).toContain('"description": "The beginning.\\n\\n**Instructions**\\n\\n> Send go."')
    }, 30_000)

    it('refuses a name the catalog lacks, even beside one it holds, and writes nothing', async () => {
      const outDir = join(project, 'out')
      await run(['stately', 'short', 'bogus', '--out', outDir], pathToFileURL(join(project, 'machines.ts')))
      expect(err.join('')).toContain('no machine named bogus; the catalog holds short')
      expect(existsSync(outDir)).toBe(false)
      expect(process.exitCode).toBe(1)
    }, 30_000)
  })

  // The clock is pinned near the run's own date. Left to the wall clock this would assert the calendar rather than
  // `doctor`: a run ages, and one written a day ago crosses the fourteen-day line two weeks later with nothing changed.
  it('doctor finds nothing to remove while every live run is younger than two weeks', async () => {
    const home = makeHome()
    writeRun(join(home, 'live', 'eeee5555-0000-4000-8000-000000000006'), '2026-09-09T00:00:00.000Z', [{ id: 'eeee5555-0000-4000-8000-000000000006', status: 'active' }])
    const before = process.env['XDG_CONFIG_HOME']
    process.env['XDG_CONFIG_HOME'] = home
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-10T00:00:00Z') })
    try {
      await run(['doctor'])
      expect(out.join('')).toContain('no live runs older than 14 days')
    } finally {
      vi.useRealTimers()
      before === undefined ? delete process.env['XDG_CONFIG_HOME'] : (process.env['XDG_CONFIG_HOME'] = before)
      rmSync(home, { recursive: true, force: true })
    }
  })

  /**
   * What `doctor` is *for* had no test: the case above only covers it finding nothing, which is why a fixture drifting
   * past fourteen days broke the suite from the untested side. A live run whose driver walked away stays live forever
   * — nothing else can tell abandonment from a long pause — so the age is the only evidence there is, and a wrong call
   * here deletes a run someone is still driving. Built from disposable runs rather than the recorded fixtures, since
   * proving the removal means performing it.
   */
  describe('doctor removes what it proposed', () => {
    const NOW = Date.parse('2026-09-10T00:00:00Z')
    const STALE = 'staleaaa-1111'
    const FRESH = 'freshbbb-2222'
    const DONE = 'donecccc-3333'
    let home: string
    let env: Record<string, string | undefined>

    /** A run the locator can find: `describeRun` reads the trace, and its last call is the run's whole age. */
    const makeRun = (where: 'live' | 'completed', id: string, at: string): string => {
      const dir = join(home, where, id)
      mkdirSync(dir, { recursive: true })
      const entry = { at, ms: 0, pid: 1, argv: ['create', 'lead'], actorId: id, exitCode: 0, response: {} }
      writeFileSync(join(dir, 'trace.jsonl'), JSON.stringify(entry) + '\n')
      return dir
    }

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'backseat-doctor-'))
      mkdirSync(join(home, 'backseat'), { recursive: true })
      writeFileSync(join(home, 'backseat', 'config.json'), JSON.stringify({ runs: { live: join(home, 'live'), completed: join(home, 'completed') } }))
      env = { XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'], BACKSEAT_STATE_DIR: process.env['BACKSEAT_STATE_DIR'] }
      process.env['XDG_CONFIG_HOME'] = home
      delete process.env['BACKSEAT_STATE_DIR']
      vi.spyOn(process, 'stdin', 'get').mockReturnValue({ isTTY: false } as unknown as typeof process.stdin)
      vi.useFakeTimers({ toFake: ['Date'], now: NOW })
      makeRun('live', STALE, '2026-08-01T00:00:00.000Z') // 40 days: abandoned
      makeRun('live', FRESH, '2026-09-09T00:00:00.000Z') // 1 day: someone is still driving it
      makeRun('completed', DONE, '2026-01-01T00:00:00.000Z') // ancient, and finished: never a candidate
    })
    afterEach(() => {
      vi.useRealTimers()
      rmSync(home, { recursive: true, force: true })
      for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v)
    })

    const dirs = () => ({ stale: existsSync(join(home, 'live', STALE)), fresh: existsSync(join(home, 'live', FRESH)), done: existsSync(join(home, 'completed', DONE)) })

    it('proposes only the abandoned live run, and removes nothing without a yes', async () => {
      await run(['doctor'])
      expect(process.exitCode).toBeUndefined()
      const printed = out.join('')
      expect(printed).toContain('1 live run untouched for 14 days')
      expect(printed).toContain(STALE.slice(0, 8))
      expect(printed).not.toContain(FRESH.slice(0, 8)) // a day old: a pause, not an abandonment
      expect(printed).not.toContain(DONE.slice(0, 8)) // finished runs are never proposed, however old
      expect(printed).toContain('run again with --yes to remove them')
      expect(dirs()).toEqual({ stale: true, fresh: true, done: true }) // proposed is not removed
    })

    it('removes the run it proposed on --yes, and only that one', async () => {
      await run(['doctor', '--yes'])
      expect(process.exitCode).toBeUndefined()
      expect(out.join('')).toContain(`removed ${STALE}`)
      expect(dirs()).toEqual({ stale: false, fresh: true, done: true })
    })

    it('trims the run-less file to its last 14 days on the same yes, which nothing else would ever shrink', async () => {
      // Every call that touches no actor lands there, about a kilobyte each, and the file is no run's record.
      const runless = join(home, 'live', 'trace.jsonl')
      const call = (at: string) => JSON.stringify({ at, ms: 0, pid: 1, argv: [], exitCode: 0, response: {} }) + '\n'
      writeFileSync(runless, call('2026-08-01T00:00:00.000Z') + call('2026-08-02T00:00:00.000Z') + call('2026-09-09T00:00:00.000Z'))
      await run(['doctor'])
      expect(out.join('')).toContain('2 run-less calls older than 14 days')
      expect(readFileSync(runless, 'utf8').trim().split('\n')).toHaveLength(3) // proposed is not removed
      await run(['doctor', '--yes'])
      expect(out.join('')).toContain('trimmed 2 run-less calls')
      expect(readFileSync(runless, 'utf8')).toBe(call('2026-09-09T00:00:00.000Z'))
    })

    it('ages a run with no trace by its files, so it is proposed rather than kept forever', async () => {
      // A record with no trace has no last call, and an age of nothing compared as never stale.
      const dir = join(home, 'live', 'notrace-4444')
      mkdirSync(dir, { recursive: true })
      const record = join(dir, 'notrace-4444.json')
      writeFileSync(record, JSON.stringify({ machine: 'lead', snapshot: { status: 'active' } }))
      utimesSync(record, new Date('2026-08-01T00:00:00Z'), new Date('2026-08-01T00:00:00Z'))
      await run(['doctor'])
      expect(out.join('')).toContain('2 live runs untouched for 14 days')
      expect(out.join('')).toContain('notrace-')
    })

    it('removes a removed run\'s scratch with it, and leaves a live one\'s alone', async () => {
      // Scratch is a sibling of the run, not inside it, so removing the run left it behind in the temp dir for good.
      for (const id of [STALE, FRESH]) mkdirSync(scratchDir(id), { recursive: true })
      try {
        await run(['doctor', '--yes'])
        expect({ stale: existsSync(scratchDir(STALE)), fresh: existsSync(scratchDir(FRESH)) }).toEqual({ stale: false, fresh: true })
      } finally {
        for (const id of [STALE, FRESH]) rmSync(scratchDir(id), { recursive: true, force: true })
      }
    })
  })
})
