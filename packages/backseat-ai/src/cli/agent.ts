import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCli, capturePin, defaultLocator, fileStore, noPin, pinModeOf, readPin, servePin } from '../runtime/index.js'
import type { PinMode, PinSession } from '../runtime/index.js'
import type { AnyStateMachine } from 'xstate'

/**
 * What the agent invokes, and what the drive protocol teaches: the project's `cli.ts` under `--drive`, run by Node
 * itself from the project's directory, so it reads the same under every package manager.
 */
export const DRIVE = 'node cli.ts --drive'

/** The catalog: what a project's machines are created by, under the names the catalog gives them. */
export type Catalog = Record<string, AnyStateMachine>

/**
 * A project: its name, and the module whose default export is the catalog — a record whose **keys are the catalog
 * names**, written as one literal so two machines cannot claim one name without TypeScript saying so.
 */
export type Project = { name: string; machines: URL }

/**
 * A project's own front for its machines: the `cli.ts` beside its `package.json` names the catalog and calls this, and
 * Node runs that file. Everything that reads a catalog lives here rather than on the `backseat-ai` bin, which
 * keeps only what reads no catalog, so the Backseat that drives, lints and draws a project's machines is always the
 * one they were built with (ADR-0012).
 *
 * `--drive` first is the agent-facing tool: `create`, `send`, `snapshot` and `describe` from the runtime's `buildCli`
 * seam (ADR-0001). Without it the arguments are a
 * person's project commands, `lint` and `stately`.
 *
 * `machines` is a URL rather than the imported module on purpose: the drive tool pins the catalog before it imports
 * it, so the file that calls this must never import the catalog itself.
 */
export async function cli(machines: URL, argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv[0] !== '--drive') {
    const { run } = await import('./human.js')
    return run(argv, machines)
  }
  argv = argv.slice(1)
  let tool: ReturnType<typeof buildCli>
  try {
    const { mode, rootId } = pinModeOf(argv)
    const project = projectOf(machines)
    if (mode === 'serve' && rootId !== undefined) await refuseForeign(rootId, project)
    const opened = await openProject(project, { mode, rootId })
    tool = buildCli({ bin: DRIVE, machines: opened.catalog, pin: opened.pin, project: { name: opened.project.name, catalog: opened.project.machines.href } })
  } catch (error) {
    // The project and what is wrong with it are in the message; nothing reaches an agent.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
  await tool.run(argv)
}

/**
 * Every project's tool is taught under the one name, so the bin a root records no longer tells two projects apart:
 * the catalog it records does. A root created from another project's catalog is refused before this catalog is
 * imported, rather than rehydrated against whichever of this catalog's machines happens to share its name.
 */
async function refuseForeign(rootId: string, project: Project): Promise<void> {
  const record = await fileStore(defaultLocator().dirOf).get(rootId)
  if (record?.catalog !== undefined && record.catalog !== project.machines.href) {
    throw new Error(`Actor '${rootId}' was created from ${fileURLToPath(record.catalog)}, not ${display(project.machines)}; drive it from ${record.project ?? 'that project'}`)
  }
}

/** The project a catalog belongs to: the nearest `package.json` above it names it. */
export function projectOf(machines: URL): Project {
  const from = dirname(fileURLToPath(machines))
  let dir = from
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`no package.json above ${from}; a catalog belongs to a project, which its package.json names`)
    dir = parent
  }
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }
  if (typeof manifest.name !== 'string' || !manifest.name) throw new Error(`${join(dir, 'package.json')} has no name; the project is named by it`)
  return { name: manifest.name, machines }
}

/**
 * The pin, then the catalog, in that order: what every front for a project's machines has to do before it can act,
 * whether it is the drive tool reading argv or something else deriving `mode` from a request. `create` captures,
 * because its run directory does not exist yet; every later call on an actor serves the pin its run holds, and a run
 * with none — finished and shed — runs live.
 */
export async function openProject(project: Project, { mode, rootId }: { mode: PinMode; rootId?: string }): Promise<{ project: Project; catalog: Catalog; pin: PinSession }> {
  let pin: PinSession = noPin()
  if (mode === 'capture') {
    pin = capturePin()
  } else if (mode === 'serve' && rootId !== undefined) {
    const stored = readPin(defaultLocator().dirOf(rootId), rootId)
    if (stored) pin = servePin(stored)
  }
  // Imported after the hooks are in place, so this is the module the pin is of.
  const catalog = await importCatalog(project.machines)
  if (mode === 'capture' && !pin.has(project.machines.href)) {
    throw new Error(`${display(project.machines)} was imported before the run could pin it; nothing may import the catalog before the tool does`)
  }
  return { project, catalog, pin }
}

/**
 * The catalog module, imported and checked. A machine is a TypeScript value and the only thing that can turn it into
 * a machine is running it, so the module is imported, never bundled or read as data. A machine registers itself:
 * `createMachine` runs every check that once needed a separate pass, so importing this module *is* the verification,
 * and a machine that fails it throws before any of them reaches an agent.
 *
 * That holds for **correctness**, which is the only thing registration is about. Style is a second question and gets
 * a second surface: `lint` reports the style facts
 * a walk over a built machine can establish, and is a command a human chooses to run rather than a pass an
 * import cannot skip. Refusing to start a machine over a redundant sentence would be absurd, and a check that stops
 * the process is the only kind registration has.
 */
export async function importCatalog(url: URL): Promise<Catalog> {
  const module_ = (await import(url.href)) as { default?: unknown }
  const catalog = module_.default
  if (catalog === undefined) throw new Error(`${display(url)} has no default export; the catalog is its default export, a record of machines by the name each is created under`)
  if (typeof catalog !== 'object' || catalog === null || Array.isArray(catalog)) throw new Error(`${display(url)} default-exports ${Array.isArray(catalog) ? 'an array' : typeof catalog}; the catalog is a record of machines by the name each is created under`)
  for (const [name, machine] of Object.entries(catalog)) {
    if (!isMachine(machine)) throw new Error(`${display(url)}: '${name}' is not a machine; every value in the catalog comes from backseat().createMachine`)
  }
  return catalog as Catalog
}

/** A built machine, as opposed to whatever else a module might export. */
function isMachine(value: unknown): value is AnyStateMachine {
  return typeof value === 'object' && value !== null && 'root' in value && typeof (value as { provide?: unknown }).provide === 'function'
}

const display = (url: URL) => fileURLToPath(url).replace(`${process.cwd()}/`, '')
