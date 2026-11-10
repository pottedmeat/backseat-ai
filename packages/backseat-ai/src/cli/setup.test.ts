import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importCatalog } from './agent.js'
import { checkCliTs, detectManager, managerSpawn, npmName, scanMachines, setup } from './setup.js'

/**
 * `backseat-ai init` has to work in an empty directory, in a package someone already has, and after machines are written,
 * and running it again is how a half-set-up project gets finished. Every case here runs without a terminal and
 * without installing: without a terminal is how an agent runs it, and the one thing it must never do there is
 * replace what a person wrote without being told `--yes`.
 */
const DEMO = resolve(import.meta.dirname, '..', '..', '..', '..', 'demos', 'one-value')
const COMPILER = resolve(import.meta.dirname, '..', 'compiler', 'index.ts')

describe('backseat-ai init', () => {
  let dir: string
  let out: string[]
  let cwd: string
  const write = (name: string, text: string) => {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  const read = (name: string) => readFileSync(join(dir, name), 'utf8')
  const lines = () => out.join('').split('\n')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'backseat-init-'))
    out = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (out.push(String(chunk)), true))
    cwd = process.cwd()
    process.chdir(dir)
    process.exitCode = undefined
  })
  afterEach(() => {
    vi.restoreAllMocks()
    process.chdir(cwd)
    rmSync(dir, { recursive: true, force: true })
    process.exitCode = undefined
  })

  it('sets an empty directory up with a starter machine that registers, and a second run finds nothing to do', async () => {
    await setup(['starter-demo', '--starter', '--no-install'])
    expect(process.exitCode).toBeUndefined()
    const pkg = JSON.parse(read('package.json'))
    expect(pkg).toMatchObject({ name: 'starter-demo', type: 'module' })
    // Agents and people run `node cli.ts`, under any package manager, so no script stands in for it.
    expect(Object.keys(pkg.scripts)).toEqual(['typecheck'])
    // TypeScript 7 has no compiler API, and `stately` must work after a fresh init.
    expect(pkg.devDependencies.typescript5).toMatch(/^npm:typescript@\^5/)
    expect(Object.keys(pkg.dependencies)).toEqual(['backseat-ai', 'xstate', 'zod'])
    expect(JSON.parse(read('tsconfig.json')).compilerOptions).toMatchObject({ module: 'nodenext', allowImportingTsExtensions: true, noEmit: true })
    expect(checkCliTs(read('cli.ts'), 'machines.ts')).toBeUndefined()
    // The starter is only worth writing if the catalog it lands in is one `create` accepts.
    write('starter-demo.ts', read('starter-demo.ts').replace("'backseat-ai'", JSON.stringify(COMPILER)))
    expect(Object.keys(await importCatalog(pathToFileURL(join(dir, 'machines.ts'))))).toEqual(['starter-demo'])

    out = []
    await setup(['--no-install'])
    // Only the install is left, and a run with `--no-install` says so rather than calling the project set up.
    expect(lines().filter((l) => l && !l.startsWith('ok') && !l.startsWith('Run '))).toEqual([expect.stringMatching(/^skipped {3}install — run `\w+ install`$/)])
  })

  it('writes nothing for a catalog when there is no machine yet, and says to run it again', async () => {
    await setup(['--no-install'])
    expect(out.join('')).toContain('skipped   machines.ts — no machine yet')
    expect(out.join('')).toContain('Run `npx backseat-ai setup` again any time')
    expect(() => read('machines.ts')).toThrow()
  })

  it('never replaces what a person wrote without a yes, lists each conflict with its fix, and fails', async () => {
    const pkg = JSON.stringify({ name: 'theirs', type: 'commonjs' })
    write('package.json', pkg)
    write('cli.ts', "import machines from './machines.ts'\n")
    await setup(['--no-install'])
    expect(process.exitCode).toBe(1)
    expect(out.join('')).toContain('conflict  package.json type — is "commonjs"')
    expect(out.join('')).toContain('conflict  cli.ts — imports ./machines.ts, so a run cannot pin the catalog')
    expect(JSON.parse(read('package.json'))).toMatchObject({ type: 'commonjs' })
    expect(read('cli.ts')).toBe("import machines from './machines.ts'\n")

    out = []
    process.exitCode = undefined
    await setup(['--no-install', '--yes'])
    expect(JSON.parse(read('package.json'))).toMatchObject({ type: 'module', scripts: { typecheck: 'tsc' } })
    expect(checkCliTs(read('cli.ts'), 'machines.ts')).toBeUndefined()
  })

  it('keeps a typecheck script the project already has, even under --yes', async () => {
    // Nothing in Backseat runs it, so a project's own `tsc --noEmit` is as good as `tsc`, and calling it a conflict
    // failed every run without a terminal and overwrote it under --yes.
    write('package.json', JSON.stringify({ name: 'theirs', type: 'module', scripts: { typecheck: 'tsc --noEmit' } }))
    await setup(['--no-install', '--yes'])
    expect(out.join('')).toContain('ok        scripts.typecheck')
    expect(JSON.parse(read('package.json')).scripts).toEqual({ typecheck: 'tsc --noEmit' })
  })

  it('leaves a tsconfig it cannot safely rewrite to be checked by hand, naming the flags', async () => {
    write('tsconfig.json', '{ "extends": "../base.json" }\n')
    await setup(['--no-install'])
    expect(out.join('')).toContain('skipped   tsconfig.json — extends another config, so check by hand that it sets module: "nodenext"')
    expect(read('tsconfig.json')).toBe('{ "extends": "../base.json" }\n')
  })

  it('registers the machines a project already has, leaving out the one another machine spawns', async () => {
    write('one-value.ts', readFileSync(join(DEMO, 'one-value.ts'), 'utf8'))
    await setup(['--no-install'])
    expect(read('machines.ts')).toContain("import { lead } from './one-value.ts'")
    expect(read('machines.ts')).toMatch(/export default \{\n {2}lead,\n\}/)
    expect(out.join('')).toContain('leaves out worker from one-value.ts, which another machine spawns')
  })

  it('points at a machine the catalog does not register, and edits no catalog a person wrote', async () => {
    write('one-value.ts', readFileSync(join(DEMO, 'one-value.ts'), 'utf8'))
    write('machines.ts', 'export default {}\n')
    await setup(['--no-install'])
    expect(out.join('')).toContain('note      machines.ts — does not register lead from one-value.ts')
    expect(read('machines.ts')).toBe('export default {}\n')
  })

  it('depends on the workspace’s own backseat-ai inside a pnpm workspace that holds it', async () => {
    write('pnpm-lock.yaml', '')
    write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n  - demos/*\n')
    write('packages/backseat-ai/package.json', JSON.stringify({ name: 'backseat-ai' }))
    mkdirSync(join(dir, 'demos', 'new'), { recursive: true })
    process.chdir(join(dir, 'demos', 'new'))
    await setup(['--no-install'])
    expect(JSON.parse(read('demos/new/package.json')).dependencies['backseat-ai']).toBe('workspace:*')
    expect(out.join('')).toContain('run `pnpm install`')
  })
})

describe('what init reads without importing', () => {
  it('finds machines made by a destructured, aliased or direct createMachine, only in files that import backseat-ai', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backseat-scan-'))
    try {
      writeFileSync(join(dir, 'a.ts'), "import { backseat } from 'backseat-ai'\nconst { createMachine: make } = backseat<C>()\nexport const alpha = make({})\n")
      writeFileSync(join(dir, 'b.ts'), "import { backseat } from 'backseat-ai'\nexport const beta = backseat<C, E>().createMachine({ actors: { alpha } })\n")
      writeFileSync(join(dir, 'c.ts'), 'const { createMachine } = backseat()\nexport const gamma = createMachine({})\n')
      writeFileSync(join(dir, 'b.test.ts'), "import { backseat } from 'backseat-ai'\nexport const delta = backseat().createMachine({})\n")
      expect(scanMachines(dir)).toEqual({ machines: [{ name: 'beta', file: 'b.ts' }], spawned: [{ name: 'alpha', file: 'a.ts' }] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('takes the package manager from the nearest lockfile, then from whatever ran it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backseat-pm-'))
    const agent = process.env['npm_config_user_agent']
    try {
      mkdirSync(join(dir, 'inner'))
      process.env['npm_config_user_agent'] = 'bun/1.2.0'
      expect(detectManager(join(dir, 'inner')).name).toBe('bun')
      writeFileSync(join(dir, 'yarn.lock'), '')
      expect(detectManager(join(dir, 'inner'))).toMatchObject({ name: 'yarn' })
      expect(detectManager(dir).add(['zod@^4'], true)).toEqual(['add', '-D', 'zod@^4'])
    } finally {
      agent === undefined ? delete process.env['npm_config_user_agent'] : (process.env['npm_config_user_agent'] = agent)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a cli.ts that imports the catalog, names another, or never calls cli', () => {
    expect(checkCliTs("await cli(new URL('./machines.ts', import.meta.url))", 'machines.ts')).toBeUndefined()
    expect(checkCliTs("import m from './machines.ts'\nawait cli(new URL('./machines.ts', import.meta.url))", 'machines.ts')).toContain('imports ./machines.ts')
    expect(checkCliTs("await cli(new URL('./catalog.ts', import.meta.url))", 'machines.ts')).toBe('names ./catalog.ts, but the catalog is ./machines.ts')
    expect(checkCliTs('', 'machines.ts')).toContain('does not call cli(')
  })

  it('makes a package name npm accepts out of a directory name', () => {
    expect(npmName('My Demo!')).toBe('my-demo')
    expect(npmName('...')).toBe('backseat-project')
  })
})

describe('starting the package manager', () => {
  it('goes through a shell on Windows, quoting each argument so cmd.exe keeps the ^ in a range', () => {
    // On Windows the manager is a `.cmd` shim, which Node refuses to start without a shell; through cmd.exe an
    // unquoted `^5.32.6` loses its caret, so the range installed would be an exact version. Untested on Windows.
    expect(managerSpawn('npm', ['install', '-D', 'xstate@^5.32.6'], 'win32')).toEqual({ command: '"npm" "install" "-D" "xstate@^5.32.6"', args: [], shell: true })
    expect(managerSpawn('npm', ['install', 'xstate@^5.32.6'], 'darwin')).toEqual({ command: 'npm', args: ['install', 'xstate@^5.32.6'], shell: false })
  })
})
