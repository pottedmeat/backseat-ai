import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cli, importCatalog, projectOf } from './agent.js'

/**
 * A project's `cli.ts` names its catalog and hands it to `cli()`; under `--drive` that is the agent's tool (ADR-0012).
 * The pin it registers on `create` is process-global, so capturing lives in the runtime's own child-process tests;
 * what is exercised here is naming the project, the catalog checked as it is imported, and a root from another
 * project's catalog refused rather than driven by whichever machine here shares its name.
 */
const COMPILER = resolve(import.meta.dirname, '..', 'compiler', 'index.ts')
const MACHINE = `backseat().createMachine({
  id: 'silent',
  description: 'A machine whose ending says nothing.',
  initial: 'start',
  states: {
    start: { description: 'The beginning.', instructions: 'Send go.', on: { go: { target: 'done', description: 'Finish.' } } },
    done: { type: 'final', description: 'Finished.' },
  },
})`
const SNAPSHOT = { status: 'active', value: 'start', context: { agent: { shown: {}, visited: [], taught: false } }, children: {} }
const CATALOG = `import { backseat } from ${JSON.stringify(COMPILER)}\nexport default { silent: ${MACHINE} }\n`

describe('a project’s cli under --drive', () => {
  let dir: string
  let out: string[]
  let err: string[]
  let env: string | undefined
  let cwd: string
  const write = (name: string, text: string) => {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
    return pathToFileURL(join(dir, name))
  }
  /** A project: a `package.json` naming it, and the catalog beside it. */
  const project = (name: string, at = '') => {
    write(join(at, 'package.json'), JSON.stringify({ name, type: 'module' }))
    return write(join(at, 'machines.ts'), CATALOG)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'backseat-cli-'))
    out = []
    err = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (out.push(String(chunk)), true))
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (err.push(String(chunk)), true))
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit ${code}`)
    })
    env = process.env['BACKSEAT_STATE_DIR']
    process.env['BACKSEAT_STATE_DIR'] = join(dir, 'state')
    cwd = process.cwd()
    process.exitCode = undefined
  })
  afterEach(() => {
    vi.restoreAllMocks()
    process.chdir(cwd)
    env === undefined ? delete process.env['BACKSEAT_STATE_DIR'] : (process.env['BACKSEAT_STATE_DIR'] = env)
    rmSync(dir, { recursive: true, force: true })
    process.exitCode = undefined
  })

  it('names the project by the nearest package.json above the catalog, and refuses one without a name', () => {
    const machines = write(join('deep', 'inside', 'machines.ts'), CATALOG)
    write('package.json', JSON.stringify({ name: 'quiet' }))
    expect(projectOf(machines)).toEqual({ name: 'quiet', machines })
    write('package.json', JSON.stringify({}))
    expect(() => projectOf(machines)).toThrow('has no name')
  })

  it('fronts its catalog under the command that runs it, which is the name the agent is taught', async () => {
    await cli(project('quiet'), ['--drive'])
    expect(process.exitCode).toBeUndefined()
    expect(out.join('')).toContain('`node cli.ts --drive` fronts these machines:')
    expect(out.join('')).toContain('**silent**')
    expect(out.join('')).toContain('`node cli.ts --drive create <machine>`')
  })

  it('says plainly when another user owns the run directory, and how to get past it, instead of crashing', async () => {
    // A shared temp dir can be claimed first by someone who could then read every run's payloads. An agent has to get
    // a message it can act on, and the remedy has to be one that works: pinning a run does not move its scratch.
    const machines = project('quiet', 'quiet')
    const xdg = process.env['XDG_STATE_HOME']
    delete process.env['BACKSEAT_STATE_DIR']
    process.env['XDG_STATE_HOME'] = join(dir, 'xdg')
    vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1)
    try {
      await expect(cli(machines, ['--drive'])).rejects.toThrow('exit 1')
    } finally {
      if (xdg === undefined) delete process.env['XDG_STATE_HOME']
      else process.env['XDG_STATE_HOME'] = xdg
    }
    expect(err.join('')).toMatch(/belongs to another user.*TMPDIR/)
  })

  it('drives a root its own catalog created, from any working directory', async () => {
    const machines = project('quiet', 'quiet')
    const id = 'aaaa1111-0000-4000-8000-000000000001'
    write(join('state', `${id}.json`), JSON.stringify({ machine: 'silent', snapshot: SNAPSHOT, project: 'quiet', catalog: machines.href }))
    process.chdir(tmpdir())
    await cli(machines, ['--drive', 'snapshot', id])
    expect(err.join('')).toBe('')
    expect(process.exitCode).toBeUndefined()
    expect(out.join('')).toContain('at start')
  })

  it('refuses a root another project’s catalog created, though a machine here shares its name', async () => {
    // Every project's tool is taught as the one command, so the recorded catalog is what tells them apart.
    const theirs = project('theirs', 'theirs')
    const ours = project('ours', 'ours')
    const id = 'aaaa1111-0000-4000-8000-000000000002'
    write(join('state', `${id}.json`), JSON.stringify({ machine: 'silent', snapshot: SNAPSHOT, project: 'theirs', catalog: theirs.href }))
    await expect(cli(ours, ['--drive', 'snapshot', id])).rejects.toThrow('exit 1')
    expect(err.join('')).toContain('drive it from theirs')
    expect(out.join('')).toBe('')
  })

  it('hands everything without --drive to the project commands, and nothing else', async () => {
    await cli(project('quiet'), ['report'])
    expect(process.exitCode).toBe(1)
    expect(err.join('')).toContain("unknown command 'report'")
    // An author outside this repo typed `node cli.ts output` and got only lint and stately back.
    expect(err.join('')).toContain("'report' is a backseat-ai command: `npx backseat-ai report`")
  })

  it('refuses a catalog that is not a record of built machines, saying which entry is wrong', async () => {
    await expect(importCatalog(write('none.ts', 'export const x = 1\n'))).rejects.toThrow('has no default export')
    await expect(importCatalog(write('list.ts', 'export default []\n'))).rejects.toThrow('default-exports an array')
    await expect(importCatalog(write('plain.ts', "export default { thing: { root: true } }\n"))).rejects.toThrow("'thing' is not a machine")
  })
})
