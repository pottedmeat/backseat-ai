import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, sep } from 'node:path'
import { ask } from './human.js'

/**
 * `backseat-ai init`, also `backseat-ai setup`: brings the working directory up to a project whose `cli.ts` fronts its
 * machines — a `package.json` with the scripts and the dependencies, a `tsconfig.json` that lets a machine import
 * its siblings by their `.ts` names, the `cli.ts`, and a catalog. It is on the global bin because it reads no catalog:
 * the machines it registers are found by reading their source, never by importing them, and the one check that loads
 * them runs the project's own `cli.ts` in a child process.
 *
 * Run it in an empty directory, in an existing package, or after machines are written; each run finishes what is
 * missing and says `ok` to what is not, so running it again is how a half-set-up project is finished. What a person
 * wrote is never replaced without a yes: on a terminal each conflict is asked about, and without one `--yes` accepts
 * every fix and anything else lists them and exits 1.
 */
export async function setup(args: string[]): Promise<void> {
  const flags = new Set(args.filter((a) => a.startsWith('--')))
  const [given] = args.filter((a) => !a.startsWith('--'))
  const dir = process.cwd()
  const tty = Boolean(process.stdin.isTTY)
  let unresolved = 0
  let failed = false
  let remains = false

  const say = (outcome: Outcome, subject: string, detail?: string) => process.stdout.write(`${outcome.padEnd(9)} ${subject}${detail ? ` — ${detail}` : ''}\n`)
  /** A conflict is fixed on a yes and only on a yes; one left standing fails the run, so an agent cannot miss it. */
  const conflict = async (subject: string, problem: string, fix: string, apply: () => void) => {
    const yes = flags.has('--yes') || (tty && (await ask(`${subject}: ${problem}. ${fix}? [y/N] `)).toLowerCase() === 'y')
    if (yes) {
      apply()
      say('updated', subject, fix)
    } else {
      unresolved += 1
      say('conflict', subject, `${problem}; ${fix}`)
    }
  }

  // ---- package.json ---------------------------------------------------------------------------------------------
  const pkgPath = join(dir, 'package.json')
  let pkg: Manifest
  let indent = 2
  if (!existsSync(pkgPath)) {
    const suggested = npmName(given ?? basename(dir))
    const name = given !== undefined || !tty ? suggested : npmName((await ask(`Project name [${suggested}] `)) || suggested)
    pkg = { name, private: true, type: 'module' }
    say('created', 'package.json', name)
  } else {
    const text = readFileSync(pkgPath, 'utf8')
    indent = /^\{\n([ \t]+)"/.exec(text)?.[1]?.length ?? 2
    pkg = JSON.parse(text) as Manifest
    if (typeof pkg.name !== 'string' || !pkg.name) {
      pkg.name = npmName(given ?? basename(dir))
      say('updated', 'package.json name', `${pkg.name}; every run records the project by it`)
    }
    if (pkg.type === undefined) {
      pkg.type = 'module'
      say('updated', 'package.json type', 'module; the catalog is an ES module')
    } else if (pkg.type !== 'module') {
      await conflict('package.json type', `is "${pkg.type}", and the catalog is an ES module`, 'set it to "module"', () => (pkg.type = 'module'))
    } else say('ok', 'package.json')
  }
  pkg.scripts ??= {}
  // Added when missing, and one the project already has is its own: nothing in Backseat runs these.
  for (const [script, command] of Object.entries(SCRIPTS)) {
    if (pkg.scripts[script] === undefined) {
      pkg.scripts[script] = command
      say('updated', `scripts.${script}`, command)
    } else say('ok', `scripts.${script}`)
  }
  const savePkg = () => writeFileSync(pkgPath, JSON.stringify(pkg, null, indent) + '\n')
  savePkg()

  // ---- dependencies ---------------------------------------------------------------------------------------------
  const manager = detectManager(dir)
  const wanted = wantedDependencies(manager)
  const has = (name: string) => [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies].some((deps) => deps?.[name] !== undefined)
  const missing = { dependencies: Object.entries(wanted.dependencies).filter(([name]) => !has(name)), devDependencies: Object.entries(wanted.devDependencies).filter(([name]) => !has(name)) }
  if (!missing.dependencies.length && !missing.devDependencies.length) {
    if (installed(dir)) say('ok', 'dependencies')
    else if (flags.has('--no-install')) {
      say('skipped', 'install', `run \`${manager.name} install\``)
      remains = true
    } else {
      // Declared, as a `--no-install` run leaves them, but not yet installed: installing is what is missing.
      process.stdout.write(`$ ${manager.name} install\n`)
      const result = runManager(manager.name, ['install'], dir)
      if (result.status === 0) say('updated', 'dependencies', 'installed')
      else {
        failed = true
        say('failed', 'dependencies', `\`${manager.name} install\` exited ${result.status ?? result.error?.message}`)
      }
    }
  } else if (flags.has('--no-install')) {
    for (const field of ['dependencies', 'devDependencies'] as const) {
      if (!missing[field].length) continue
      pkg[field] = sortKeys({ ...pkg[field], ...Object.fromEntries(missing[field]) })
      say('updated', field, missing[field].map(([name, range]) => `${name}@${range}`).join(' '))
    }
    savePkg()
    say('skipped', 'install', `run \`${manager.name} install\``)
    remains = true
  } else {
    for (const [field, dev] of [['dependencies', false], ['devDependencies', true]] as const) {
      if (!missing[field].length) continue
      const argv = manager.add(missing[field].map(([name, range]) => `${name}@${range}`), dev)
      process.stdout.write(`$ ${manager.name} ${argv.join(' ')}\n`)
      const result = runManager(manager.name, argv, dir)
      if (result.status === 0) say('updated', field, missing[field].map(([name]) => name).join(' '))
      else {
        failed = true
        say('failed', field, `\`${manager.name} ${argv.join(' ')}\` exited ${result.status ?? result.error?.message}`)
      }
    }
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Manifest // the manager rewrote it
  }

  // ---- tsconfig.json --------------------------------------------------------------------------------------------
  const tsPath = join(dir, 'tsconfig.json')
  if (!existsSync(tsPath)) {
    writeFileSync(tsPath, JSON.stringify(TSCONFIG, null, 2) + '\n')
    say('created', 'tsconfig.json')
  } else {
    let tsconfig: { extends?: unknown; compilerOptions?: Record<string, unknown> } | undefined
    try {
      tsconfig = JSON.parse(readFileSync(tsPath, 'utf8'))
    } catch {
      tsconfig = undefined // comments, most likely: read by tsc, not by JSON.parse, and not rewritten here
    }
    const options = tsconfig?.compilerOptions ?? {}
    const wrong = Object.entries(TS_REQUIRED).filter(([key, value]) => String(options[key]).toLowerCase() !== String(value))
    const needs = Object.entries(TS_REQUIRED).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ')
    if (!wrong.length) say('ok', 'tsconfig.json')
    else if (tsconfig === undefined || tsconfig.extends !== undefined) {
      say('skipped', 'tsconfig.json', `${tsconfig ? 'extends another config' : 'is not plain JSON'}, so check by hand that it sets ${needs}`)
      remains = true
    } else {
      const fix = wrong.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ')
      await conflict('tsconfig.json', `does not set ${fix}, which a machine importing its siblings by their .ts names needs`, `set ${fix}`, () => {
        tsconfig!.compilerOptions = { ...options, ...Object.fromEntries(wrong) }
        writeFileSync(tsPath, JSON.stringify(tsconfig, null, 2) + '\n')
      })
    }
  }

  // ---- the catalog, and the cli.ts that names it ----------------------------------------------------------------
  const catalogs = ['machines.ts', 'machines.js'].filter((file) => existsSync(join(dir, file)))
  const catalog = catalogs[0] ?? 'machines.ts'
  if (catalogs.length > 1) {
    say('conflict', 'catalog', `both ${catalogs.join(' and ')} exist; keep one, since cli.ts names one`)
    unresolved += 1
  }

  const cliPath = join(dir, 'cli.ts')
  const cliText = cliTs(catalog)
  if (!existsSync(cliPath)) {
    writeFileSync(cliPath, cliText)
    say('created', 'cli.ts')
  } else {
    const problem = checkCliTs(readFileSync(cliPath, 'utf8'), catalog)
    if (problem) await conflict('cli.ts', problem, 'replace it with the standard cli.ts', () => writeFileSync(cliPath, cliText))
    else say('ok', 'cli.ts')
  }

  const found = scanMachines(dir, [catalog, 'cli.ts'])
  if (catalogs.length) {
    const text = readFileSync(join(dir, catalog), 'utf8')
    const unlisted = found.machines.filter(({ name }) => !new RegExp(`\\b${name}\\b`).test(text))
    if (!unlisted.length) say('ok', catalog)
    for (const { name, file } of unlisted) say('note', catalog, `does not register ${name} from ${file}; add it if an agent should create it`)
  } else if (found.machines.length) {
    writeFileSync(join(dir, catalog), catalogTs(found.machines))
    say('created', catalog, `registers ${found.machines.map(({ name, file }) => `${kebab(name)} (${name} from ${file})`).join(', ')}`)
    for (const { name, file } of found.spawned) say('note', catalog, `leaves out ${name} from ${file}, which another machine spawns; add it if an agent should also create it directly`)
  } else {
    const choice = flags.has('--starter') ? 's' : flags.has('--empty') ? 'e' : tty ? (await ask('No machine yet. Write a [s]tarter machine, an [e]mpty catalog, or [n]othing for now? [s/e/N] ')).toLowerCase() : 'n'
    const key = npmName(pkg.name ?? basename(dir)).replace(/^@[^/]+\//, '')
    const starter = `${key}.ts`
    if (choice === 's' && existsSync(join(dir, starter))) {
      say('conflict', starter, 'already exists and defines no machine this can find; register one in machines.ts by hand')
      unresolved += 1
    } else if (choice === 's') {
      writeFileSync(join(dir, starter), starterTs(key))
      writeFileSync(join(dir, catalog), catalogTs([{ name: camel(key), file: starter }], { [camel(key)]: key }))
      say('created', starter, 'the smallest machine: one move, then finished')
      say('created', catalog, `registers ${key}`)
    } else if (choice === 'e') {
      writeFileSync(join(dir, catalog), catalogTs([]))
      say('created', catalog, 'empty; register each machine an agent may create')
      remains = true
    } else {
      say('skipped', catalog, 'no machine yet')
      remains = true
    }
  }

  // ---- the gate: the project's own copy imports the catalog -------------------------------------------------------
  if (existsSync(join(dir, catalog)) && installed(dir) && !unresolved) {
    const result = spawnSync(process.execPath, ['cli.ts', '--drive'], { cwd: dir, encoding: 'utf8' })
    const names = [...(result.stdout ?? '').matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1])
    if (result.status === 0) say('ok', 'node cli.ts --drive', names.length ? `fronts ${names.join(', ')}` : 'fronts no machine yet')
    else {
      failed = true
      say('failed', 'node cli.ts --drive', (result.stderr || result.stdout).trim().split('\n').at(-1) ?? `exited ${result.status}`)
    }
  }

  if (unresolved || failed || remains) {
    process.stdout.write(`\nRun \`npx backseat-ai setup\` again any time; it finishes what is missing and leaves the rest alone.\n`)
    if (unresolved && !tty) process.stdout.write('Without a terminal nothing is replaced: fix each conflict by hand, or re-run with --yes to accept every fix above.\n')
  } else {
    process.stdout.write(`\nSet up. Start a machine with \`node cli.ts --drive create <machine>\`; lint with \`node cli.ts lint\`.\n`)
  }
  if (unresolved || failed) process.exitCode = 1
}

/**
 * How to start the package manager. On Windows it is a `.cmd` shim, which Node starts only through a shell, and cmd.exe
 * reads the `^` of a range as an escape unless the argument is quoted. Untested on Windows.
 */
export function managerSpawn(name: string, argv: string[], platform: NodeJS.Platform = process.platform): { command: string; args: string[]; shell: boolean } {
  if (platform === 'win32') return { command: [name, ...argv].map((arg) => `"${arg}"`).join(' '), args: [], shell: true }
  return { command: name, args: argv, shell: false }
}

function runManager(name: string, argv: string[], dir: string) {
  const { command, args, shell } = managerSpawn(name, argv)
  return spawnSync(command, args, { cwd: dir, stdio: 'inherit', shell })
}

type Outcome = 'created' | 'updated' | 'ok' | 'conflict' | 'skipped' | 'failed' | 'note'
type Manifest = {
  name?: string
  type?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  [key: string]: unknown
}

/** The scripts a project needs. Its `cli.ts` takes none: agents and people alike run it as `node cli.ts`. */
const SCRIPTS: Record<string, string> = { typecheck: 'tsc' }

/** What a machine file needs of the compiler: nodenext resolution, and importing a sibling by its `.ts` name. */
const TS_REQUIRED = { module: 'nodenext', moduleResolution: 'nodenext', allowImportingTsExtensions: true, noEmit: true }

/** The repo's `tsconfig.base.json`, inline because a project has no base to extend, less what only matters to emit. */
const TSCONFIG = {
  compilerOptions: {
    target: 'es2023',
    lib: ['es2023'],
    module: 'nodenext',
    moduleResolution: 'nodenext',
    strict: true,
    noUncheckedIndexedAccess: true,
    verbatimModuleSyntax: true,
    skipLibCheck: true,
    types: ['node'],
    noEmit: true,
    allowImportingTsExtensions: true,
  },
  include: ['**/*.ts'],
}

/** A string as a package name npm accepts: lower case, and nothing but what a name may hold. */
export function npmName(raw: string): string {
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._~/@-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
  return name || 'backseat-project'
}

const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
const camel = (name: string) => name.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c: string | undefined) => (c ?? '').toUpperCase()).replace(/^[^a-zA-Z_$]+/, '') || 'machine'
const sortKeys = (record: Record<string, string>) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))

export type Manager = { name: 'npm' | 'pnpm' | 'yarn' | 'bun'; add: (specs: string[], dev: boolean) => string[]; workspace?: string }

/**
 * The package manager the project is already under: a lockfile here or in a directory above (a workspace member's
 * lockfile is its root's), then the manager that ran this, then npm.
 */
export function detectManager(from: string): Manager {
  const locks: Array<[string, Manager['name']]> = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm']]
  for (let dir = from; ; dir = dirname(dir)) {
    const lock = locks.find(([file]) => existsSync(join(dir, file)))
    if (lock) return manager(lock[1], existsSync(join(dir, 'pnpm-workspace.yaml')) ? dir : undefined)
    if (dirname(dir) === dir) break
  }
  const agent = /^(npm|pnpm|yarn|bun)\//.exec(process.env['npm_config_user_agent'] ?? '')?.[1] as Manager['name'] | undefined
  return manager(agent ?? 'npm')
}

function manager(name: Manager['name'], workspace?: string): Manager {
  const add = name === 'npm' ? (specs: string[], dev: boolean) => ['install', ...(dev ? ['-D'] : []), ...specs] : (specs: string[], dev: boolean) => ['add', ...(dev ? ['-D'] : []), ...specs]
  return workspace ? { name, add, workspace } : { name, add }
}

/**
 * The dependencies a project needs, at the ranges this copy of Backseat was built against. Inside a pnpm workspace
 * that holds `backseat-ai` itself — this repo's demos — the dependency is the workspace's copy, which is the one a
 * registry install would not find.
 */
function wantedDependencies(manager: Manager): { dependencies: Record<string, string>; devDependencies: Record<string, string> } {
  const self = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as Manifest & { version: string }
  const local = manager.workspace !== undefined && workspaceHolds(manager.workspace, 'backseat-ai')
  return {
    dependencies: { 'backseat-ai': local ? 'workspace:*' : `^${self.version}`, xstate: self.peerDependencies?.['xstate'] ?? 'latest', zod: self.peerDependencies?.['zod'] ?? 'latest' },
    // `typescript5` is the compiler API `stately` reads: TypeScript 7 has none.
    devDependencies: { typescript: '^7.0.2', typescript5: 'npm:typescript@^5.9.3', '@types/node': '^26.4.1' },
  }
}

/** Whether a pnpm workspace lists a package of that name, reading only `dir/*` and plain-directory entries. */
function workspaceHolds(root: string, name: string): boolean {
  const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  const patterns = [...yaml.matchAll(/^\s*-\s*['"]?([^'"#\n]+?)['"]?\s*$/gm)].map((m) => m[1]!)
  const dirs = patterns.flatMap((pattern) => {
    if (!pattern.endsWith('/*')) return [join(root, pattern)]
    const parent = join(root, pattern.slice(0, -2))
    return existsSync(parent) ? readdirSync(parent, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(parent, e.name)) : []
  })
  return dirs.some((dir) => {
    try {
      return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest).name === name
    } catch {
      return false
    }
  })
}

/** Whether the project resolves its own copy of Backseat, which the gate runs. */
function installed(dir: string): boolean {
  try {
    createRequire(join(dir, 'package.json')).resolve('backseat-ai/cli')
    return true
  } catch {
    return false
  }
}

const cliTs = (catalog: string) => `// This project's front for its machines: \`node cli.ts --drive\` is the agent's tool, \`node cli.ts\` a person's.
// The catalog is named here and never imported, so a run can pin it before anything loads it.
import { cli } from 'backseat-ai/cli'

await cli(new URL('./${catalog}', import.meta.url))
`

/**
 * What is wrong with a `cli.ts`, or `undefined`: it has to name the catalog by URL and never import it, or the run
 * cannot pin the catalog before it loads.
 */
export function checkCliTs(text: string, catalog: string): string | undefined {
  const stem = catalog.replace(/\.[cm]?[jt]s$/, '')
  if (new RegExp(`(?:from|import\\()\\s*['"]\\./${stem}(?:\\.[cm]?[jt]s)?['"]`).test(text)) return `imports ./${catalog}, so a run cannot pin the catalog before it loads`
  const named = /cli\(\s*new URL\(\s*['"]\.\/([^'"]+)['"]/.exec(text)?.[1]
  if (named === undefined) return `does not call cli(new URL('./${catalog}', import.meta.url))`
  if (named !== catalog) return `names ./${named}, but the catalog is ./${catalog}`
  return undefined
}

const catalogTs = (machines: Array<{ name: string; file: string }>, keys: Record<string, string> = {}) => {
  const byFile = new Map<string, string[]>()
  for (const { name, file } of machines) byFile.set(file, [...(byFile.get(file) ?? []), name])
  const imports = [...byFile].map(([file, names]) => `import { ${names.join(', ')} } from './${file.split(sep).join('/')}'\n`).join('')
  const entries = machines.map(({ name }) => {
    const key = keys[name] ?? kebab(name)
    return `  ${key === name ? name : `${/^[a-zA-Z_$][\w$]*$/.test(key) ? key : `'${key}'`}: ${name}`},\n`
  })
  return `${imports}${imports ? '\n' : ''}/** Every machine an agent may \`create\`, under the name it creates it by. A machine only ever spawned stays out. */
export default {${entries.length ? `\n${entries.join('')}` : ''}}
`
}

const starterTs = (key: string) => `import { backseat } from 'backseat-ai'

export const ${camel(key)} = backseat().createMachine({
  id: '${key}',
  description: 'TODO: what ${key} is for.',
  context: {},
  initial: 'start',
  states: {
    start: {
      description: 'The beginning.',
      instructions: 'Do the work this machine is for, then finish.',
      on: { go: { target: 'done', description: 'Finish.' } },
    },
    done: { type: 'final', description: 'Finished.', instructions: 'Tell whoever asked for this what was done. The run ends here.' },
  },
})
`

type Found = { name: string; file: string }

/**
 * The machines a project's source defines, read and never imported: the global bin must not load a project's
 * machines, since the copy of Backseat that built them is the project's. A machine is an exported `const` made by
 * `createMachine` — called on `backseat()` directly or destructured from it, under any alias — in a file that imports
 * `backseat-ai`. One named in another machine's `actors` is spawned, and is set apart rather than registered.
 *
 * A heuristic over text, which is why whatever it registers is printed.
 */
export function scanMachines(dir: string, skip: string[] = []): { machines: Found[]; spawned: Found[] } {
  const all: Found[] = []
  const actors = new Set<string>()
  for (const file of sourceFiles(dir, dir)) {
    if (skip.includes(file)) continue
    const text = readFileSync(join(dir, file), 'utf8')
    if (!/from\s+['"]backseat-ai['"]/.test(text)) continue
    const factories = new Set<string>()
    for (const [, inner] of text.matchAll(/const\s*\{([^}]*)\}\s*=\s*backseat\b/g)) {
      for (const part of inner!.split(',').map((p) => p.trim())) {
        const alias = /^createMachine\s*:\s*([\w$]+)$/.exec(part)?.[1] ?? (part === 'createMachine' ? part : undefined)
        if (alias) factories.add(alias)
      }
    }
    for (const [, name, factory] of text.matchAll(/export\s+const\s+([\w$]+)\s*=\s*([\w$]+)\s*\(/g)) if (factories.has(factory!)) all.push({ name: name!, file })
    for (const [, name] of text.matchAll(/export\s+const\s+([\w$]+)\s*=\s*backseat\b[^\n]*?\.createMachine\s*\(/g)) all.push({ name: name!, file })
    for (const [, inner] of text.matchAll(/actors\s*:\s*\{([^}]*)\}/g)) for (const [token] of inner!.matchAll(/[\w$]+/g)) actors.add(token)
  }
  return { machines: all.filter(({ name }) => !actors.has(name)), spawned: all.filter(({ name }) => actors.has(name)) }
}

/** Source files under a project, relative to it, leaving out what is installed, built, generated or a test. */
function sourceFiles(root: string, dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.') ? [] : sourceFiles(root, path)
    if (!/\.[cm]?[jt]s$/.test(entry.name) || /\.(test|spec)\.|\.d\.[cm]?ts$|\.stately\.ts$/.test(entry.name)) return []
    return [relative(root, path)]
  })
}
