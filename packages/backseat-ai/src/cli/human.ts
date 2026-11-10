import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { DRIVE } from './agent.js'
import { defaultLocator, fileStore, ID_SEPARATOR, listRuns, outputOf, readTrace, shedScratch, staleRuns, trimTrace, writeTrace } from '../runtime/index.js'
import type { Locator, RunInfo } from '../runtime/index.js'
import type { AnyStateMachine } from 'xstate'

/**
 * The human-facing bin, and the human half of a project's `cli.ts`. Deliberately the opposite of the agent one: a human types these ad hoc, so they get a
 * conventional command reference rather than progressive disclosure. Keeping them off the agent bin is what lets
 * ADR-0001 stay true of the agent's tool while a human still
 * has somewhere to author from.
 *
 * The bin, run through `npx backseat-ai` or installed globally, holds only what reads no catalog: the run store's
 * commands, which mean the same whichever copy of Backseat runs them, and `init`, which writes a project without
 * importing its machines. What reads a catalog — `lint`, `stately` — is `projectCommands`,
 * reached through the project's own `cli.ts` ([`agent.ts`](./agent.ts)), so the copy that reads the machines is the
 * one that built them.
 */
export type Command = { description: string; flags?: string[]; run: (args: string[]) => Promise<void> }

/** A project command: the same, run against the catalog the project's `cli.ts` names. */
export type ProjectCommand = { description: string; flags?: string[]; run: (args: string[], machines: URL) => Promise<void> }

/** A live run untouched for this long is what `doctor` proposes to remove, and a run-less call this old to trim. */
const STALE_DAYS = 14

const SETUP_FLAGS = ['--yes', '--starter', '--empty', '--no-install']

export const commands: Record<string, Command> = {
  output: {
    description: 'Print a finished actor’s output: `output <actorId>`, the root id or a prefix of it, a child as `<root>/<key>`.',
    run: output,
  },
  report: {
    description: 'List every run the tool can find and render one as a trace report: `report [<root id prefix> | <dir>] [--no-open]`.',
    flags: ['--no-open'],
    run: report,
  },
  init: {
    description: 'Set the working directory up as a project — package.json, dependencies, tsconfig.json, cli.ts and a catalog — finishing whatever is missing: `init [<name>] [--yes] [--starter | --empty] [--no-install]`.',
    flags: SETUP_FLAGS,
    run: async (args) => (await import('./setup.js')).setup(args),
  },
  setup: {
    description: 'The same as `init`, by the name for afterwards: finish or repair a project, any time. It leaves what is right alone, and replaces nothing without a yes.',
    flags: SETUP_FLAGS,
    run: async (args) => (await import('./setup.js')).setup(args),
  },
  doctor: {
    description: `Propose removing live runs untouched for ${STALE_DAYS} days, and run-less calls as old; \`doctor --yes\` removes them.`,
    flags: ['--yes'],
    run: doctor,
  },
}

export const projectCommands: Record<string, ProjectCommand> = {
  lint: {
    description: 'Report the style facts a walk over each built machine can establish: `lint [<machine>...]`.',
    run: lint,
  },
  stately: {
    description: 'Write each catalog machine, and the machines it spawns, as a file to import into Stately Studio: `stately [<machine>...] [--out <dir>]`.',
    flags: ['--out'],
    run: stately,
  },
}

/** The command reference: the bin's, or with a catalog, the project's. */
export function usage(machines?: URL): string {
  const table = machines ? projectCommands : commands
  const width = Math.max(...Object.keys(table).map((name) => name.length))
  const lines = Object.entries(table).map(([name, c]) => `  ${name.padEnd(width)}  ${c.description}`)
  const footer = machines
    ? `The agent-facing tool is \`${DRIVE}\`, this same cli.ts under --drive.`
    : 'What reads a project’s machines — lint, stately, and the agent-facing tool — runs through that project’s cli.ts: `node cli.ts <command>`, and `node cli.ts --drive` for the agent.'
  return [machines ? 'node cli.ts <command>' : 'npx backseat-ai <command>', '', 'Commands:', ...lines, '', footer].join('\n')
}

/**
 * The bin's commands, or given the catalog a project's `cli.ts` names, the project's. Exit 0 for usage, 1 for an
 * unknown command or a failure.
 */
export async function run(argv: string[], machines?: URL): Promise<void> {
  const [name, ...args] = argv
  if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
    process.stdout.write(usage(machines) + '\n')
    return
  }
  if (name === '--version' || name === '-v') {
    const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
    process.stdout.write(`${version}\n`)
    return
  }
  const table = machines ? projectCommands : commands
  const command = Object.hasOwn(table, name) ? table[name] : undefined
  if (!command) {
    // A command from the other table is the likeliest mistake: the two are split by what reads a catalog, which is
    // nothing a person typing `output` into cli.ts can be expected to know.
    const other = machines
      ? Object.hasOwn(commands, name) && `'${name}' is a backseat-ai command: \`npx backseat-ai ${name}\`\n`
      : Object.hasOwn(projectCommands, name) && `'${name}' reads a project's machines: \`node cli.ts ${name}\`\n`
    process.stderr.write(`backseat-ai: unknown command '${name}'\n${other || ''}\n${usage(machines)}\n`)
    process.exitCode = 1
    return
  }
  // A mistyped flag fails rather than being ignored: `--yse` must not quietly run the command without its yes.
  const unknown = args.find((arg) => arg.startsWith('-') && !command.flags?.includes(arg))
  if (unknown !== undefined) {
    process.stderr.write(`backseat-ai ${name}: unknown flag '${unknown}'\n\n${usage(machines)}\n`)
    process.exitCode = 1
    return
  }
  try {
    await command.run(args, machines!) // a bin command takes no catalog, and ignores the one it is not given
  } catch (error) {
    process.stderr.write(`backseat-ai ${name}: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

// ---- output -----------------------------------------------------------------------------------------------------

/**
 * `backseat-ai output <actorId>` prints a finished actor's `output` — the lead's delivered report, a collected worker's
 * finding — as `{ actorId, status, output }`. It is a person's act, never the agent's,
 * so it lives here and it is a *read*: the run is neither locked nor traced, because a person reading a run must not
 * land in that run's record as a call the run made, and the store writes through a rename so nothing torn is read.
 */
async function output(args: string[]): Promise<void> {
  const given = args[0]
  if (given === undefined) throw new Error('output takes an actor id')
  const locate = defaultLocator()
  const actorId = expand(locate, given)
  process.stdout.write(JSON.stringify(await outputOf(fileStore(locate.dirOf), actorId), null, 2) + '\n')
}

/**
 * An actor id whose root segment may be a prefix, expanded the way `report` expands one — against every root in every
 * run the tool can find — because the id a person has in front of them is the short one the report showed them. An id
 * that already resolves is taken as given, so a full id never pays for the scan.
 */
function expand(locate: Locator, given: string): string {
  const [root = '', ...path] = given.split(ID_SEPARATOR)
  if (existsSync(join(locate.dirOf(root), `${root}.json`))) return given
  const matches = listRuns(locate).flatMap((run) => run.roots).filter((candidate) => candidate.id.startsWith(root))
  if (matches.length !== 1) throw new Error(matches.length ? `'${root}' matches ${matches.length} roots` : `no run whose root id starts with '${root}'`)
  return [matches[0]!.id, ...path].join(ID_SEPARATOR)
}

// ---- report -----------------------------------------------------------------------------------------------------

/**
 * `backseat-ai report` lists the runs it can find — live, completed, and the pinned directory when `BACKSEAT_STATE_DIR`
 * is set — newest first, and prompts for one on a terminal. `report <prefix>` picks the run whose root id starts so;
 * `report <dir>` renders any directory holding a trace. The page is written beside the run and opened.
 */
async function report(args: string[]): Promise<void> {
  const open = !args.includes('--no-open')
  const [pick] = args.filter((a) => !a.startsWith('--'))
  let dir: string | undefined
  if (pick !== undefined && existsSync(pick)) {
    dir = statSync(pick).isDirectory() ? resolve(pick) : dirname(resolve(pick))
  } else {
    const runs = listRuns(defaultLocator())
    if (!runs.length) throw new Error('no runs found')
    if (pick !== undefined) {
      const matches = runs.filter((run) => run.roots.some((root) => root.id.startsWith(pick)))
      if (matches.length !== 1) throw new Error(matches.length ? `'${pick}' matches ${matches.length} runs` : `no run whose root id starts with '${pick}'`)
      dir = matches[0]!.dir
    } else {
      process.stdout.write(table(runs) + '\n')
      if (!process.stdin.isTTY) return // listed; nothing to prompt
      const answer = await ask(`Report which run? [1-${runs.length}] `)
      const index = Number.parseInt(answer, 10)
      if (!(index >= 1 && index <= runs.length)) throw new Error(`no run ${answer}`)
      dir = runs[index - 1]!.dir
    }
  }
  const { path, calls } = writeTrace(dir, binOf(dir))
  process.stdout.write(`${path} (${calls} calls)\n`)
  if (open) openBrowser(path)
}

/** The bin that drove a run, from its root records; the page renders each call as that bin's command line. */
function binOf(dir: string): string {
  const run = listRuns({ dirOf: () => dir, pinned: dir, runs: undefined })
  return run.flatMap((r) => r.roots).find((root) => root.bin !== undefined)?.bin ?? DRIVE
}

const COLUMNS = ['#', 'machine', 'root', 'status', 'started', 'last call', 'calls', 'undeclared', 'where'] as const

/**
 * One row per root, so a pinned run with two leads shows both; the index is the run's, shared by its rows. `undeclared`
 * counts children that appeared which no spawn site declares, so a run says what the definition failed to name.
 */
function table(runs: RunInfo[]): string {
  const rows: string[][] = [[...COLUMNS]]
  runs.forEach((run, i) => {
    const roots = run.roots.length ? run.roots : [{ id: '', machine: undefined, status: 'unknown' as const }]
    roots.forEach((root, j) => {
      rows.push([
        j === 0 ? String(i + 1) : '',
        root.machine ?? (root.id ? '?' : '(no actor)'),
        root.id.slice(0, 8),
        root.id ? (root.status === 'active' ? 'not finished' : root.status) : '',
        j === 0 ? when(run.started) : '',
        j === 0 ? when(run.lastCall) : '',
        j === 0 ? String(run.calls) : '',
        j === 0 && run.undeclared ? String(run.undeclared) : '',
        j === 0 ? (run.where === 'pinned' ? `pinned ${run.dir}` : run.where) : '',
      ])
    })
  })
  return render(rows)
}

/** A table as two spaces between columns, every cell padded to its column's widest; the first row is the header. */
function render(rows: string[][]): string {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((row) => row[c]!.length)))
  return rows.map((row) => row.map((cell, c) => cell.padEnd(widths[c]!)).join('  ').trimEnd()).join('\n')
}

function when(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const pad = (n: number) => String(n).padStart(2, '0')

/** One line from a person at a terminal, trimmed. */
export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

// ---- doctor -----------------------------------------------------------------------------------------------------

/**
 * A live run whose driver walked away stays live forever: nothing else can tell abandonment from a long pause. `doctor`
 * proposes the ones untouched for two weeks and removes them only on a yes. On the same yes it trims the run-less file,
 * which every call that touches no actor appends to and nothing else shrinks. A pinned directory's is the run's own.
 */
async function doctor(args: string[]): Promise<void> {
  const locate = defaultLocator()
  const cutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000
  const stale = staleRuns(locate, STALE_DAYS)
  const runless = locate.runs && !locate.pinned ? locate.runs.live : undefined
  const old = runless === undefined ? 0 : readTrace(runless).filter((entry) => Date.parse(entry.at) < cutoff).length
  if (!stale.length && !old) {
    process.stdout.write(`no live runs older than ${STALE_DAYS} days\n`)
    return
  }
  if (stale.length) process.stdout.write(`${stale.length} live ${stale.length === 1 ? 'run' : 'runs'} untouched for ${STALE_DAYS} days:\n${table(stale)}\n`)
  if (old) process.stdout.write(`${old} run-less ${old === 1 ? 'call' : 'calls'} older than ${STALE_DAYS} days\n`)
  if (!args.includes('--yes')) {
    if (!process.stdin.isTTY) {
      process.stdout.write('run again with --yes to remove them\n')
      return
    }
    const answer = await ask(`Remove ${stale.length + old === 1 ? 'it' : 'them'}? [y/N] `)
    if (answer.toLowerCase() !== 'y') return
  }
  if (runless !== undefined && old) process.stdout.write(`trimmed ${await trimTrace(runless, cutoff)} run-less calls\n`)
  for (const run of stale) {
    rmSync(run.dir, { recursive: true, force: true })
    // A live run is named for its root, and its scratch is a sibling, not a part of it.
    shedScratch(basename(run.dir))
    process.stdout.write(`removed ${basename(run.dir)}\n`)
  }
}

/** The platform opener unless `BROWSER` says otherwise; nothing under `CI`, where no one is watching. */
function openBrowser(url: string): void {
  const browser = process.env['BROWSER']
  if (browser === 'none' || process.env['CI']) return
  const [command, ...args] = browser ? [browser] : process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['cmd', '/c', 'start', ''] : ['xdg-open']
  const child = spawn(command!, [...args, url], { stdio: 'ignore', detached: true })
  child.on('error', (error) => process.stderr.write(`could not open a browser (${error.message}); open the URL above\n`))
  child.unref()
}

/**
 * `lint [<machine>...]`: the style rules a walk over a built machine can establish exactly, run over every machine
 * the catalog registers and the machines they spawn. The catalog is the one the project's `cli.ts` names. A finding prints the rule's id, title and why
 * from the registry, so it explains itself without sending a person to a document.
 *
 * A separate command, where every correctness check this project has is run by importing the machine
 * ([`agent.ts`](./agent.ts)). The two are different questions. A machine that would mislead an agent must not start,
 * so registration throws; a machine that says something twice runs perfectly and is merely worse to read, and
 * refusing to start over a redundant sentence would be absurd. Style gets a surface a human chooses to run.
 *
 * There is no way to silence a finding, and deliberately so: the lint holds the built machine and never the source,
 * so the only place a suppression could live is a key on the machine value — on a surface whose premise is that every
 * key means something to an agent. An author who disagrees with a rule changes the rule, in the registry that states
 * why it holds.
 */
async function lint(args: string[], machines: URL): Promise<void> {
  const { importCatalog } = await import('./agent.js')
  const { lintMachine, styleRule } = await import('../runtime/index.js')
  const wanted = args.filter((a) => !a.startsWith('-'))
  let catalog: Awaited<ReturnType<typeof importCatalog>>
  try {
    catalog = await importCatalog(machines)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
    return
  }
  const missing = wanted.filter((name) => !Object.hasOwn(catalog, name))
  if (missing.length) {
    process.stderr.write(`no machine named ${missing.join(', ')}; the catalog holds ${Object.keys(catalog).join(', ')}\n`)
    process.exitCode = 1
    return
  }
  const reports = Object.entries(catalog)
    .filter(([name]) => wanted.length === 0 || wanted.includes(name))
    .flatMap(([name, machine]) => [lintMachine(name, machine), ...spawned(name, machine).map(([n, m]) => lintMachine(n, m))])

  let found = 0
  for (const report of reports) {
    const lines: string[] = []
    for (const finding of report.findings) {
      found += 1
      const rule = styleRule(finding.rule)
      lines.push(`  ${finding.where}\n    ${finding.fact}\n    ${rule.id}: ${rule.title}\n    ${rule.why}`)
    }
    // What a check could not see is reported too: a clean run that quietly skipped three checks reads as a clean
    // machine, and the whole value of this lint is that it is trusted when it says nothing.
    for (const declined of report.declined) lines.push(`  ${declined.rule} (${styleRule(declined.rule).title}) did not run: ${declined.because}`)
    if (lines.length) process.stdout.write(`${report.machine}\n${lines.join('\n')}\n\n`)
  }
  if (found === 0) process.stdout.write(`nothing to say about ${reports.length} ${reports.length === 1 ? 'machine' : 'machines'}\n`)
  else process.exitCode = 1
}

// ---- stately -----------------------------------------------------------------------------------------------------

/**
 * `node cli.ts stately [<machine>...] [--out <dir>]` writes `<name>.stately.ts` for each catalog machine
 * and `<name>.<src>.stately.ts` for each machine its roster spawns, one machine per file, for a person to paste into
 * Stately Studio
 * (ADR-0010). A view, and one way: nothing reads the file
 * back, and the machine value stays the only thing that is ever edited.
 */
async function stately(args: string[], machines: URL): Promise<void> {
  const { importCatalog } = await import('./agent.js')
  const { dataTypes, toStately } = await import('./stately.js')
  const outAt = args.indexOf('--out')
  const outDir = outAt < 0 ? process.cwd() : args[outAt + 1]
  if (outDir === undefined) throw new Error('--out takes the directory to write into')
  const wanted = args.filter((arg, i) => !arg.startsWith('-') && (outAt < 0 || i !== outAt + 1))
  const catalog = await importCatalog(machines)
  const missing = wanted.filter((name) => !Object.hasOwn(catalog, name))
  if (missing.length) throw new Error(`no machine named ${missing.join(', ')}; the catalog holds ${Object.keys(catalog).join(', ')}`)
  const chosen = Object.entries(catalog).filter(([name]) => wanted.length === 0 || wanted.includes(name))
  const types = await dataTypes(fileURLToPath(machines))
  mkdirSync(outDir, { recursive: true })
  for (const [name, machine] of chosen) {
    for (const { name: fileName, code } of toStately(name, machine, types)) {
      const file = join(outDir, fileName)
      writeFileSync(file, code)
      process.stdout.write(`${file}\n`)
    }
  }
}

/** The machines a catalog entry spawns, which an agent drives through the identical surface and no catalog names. */
function spawned(name: string, machine: AnyStateMachine, seen = new Set<AnyStateMachine>()): Array<[string, AnyStateMachine]> {
  seen.add(machine)
  const actors = (machine.implementations as { actors?: Record<string, unknown> }).actors ?? {}
  return Object.entries(actors).flatMap(([key, logic]) => {
    if (typeof logic !== 'object' || logic === null || !('root' in logic) || seen.has(logic as AnyStateMachine)) return []
    const child = logic as AnyStateMachine
    return [[`${name} > ${key}`, child] as [string, AnyStateMachine], ...spawned(`${name} > ${key}`, child, seen)]
  })
}
