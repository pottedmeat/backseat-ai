import { describe, expect, it } from 'vitest'
import { PAGE } from './trace-page.js'
import { renderTrace, type TraceEntry } from './trace.js'

// The page had no test at all, which is how `typeof r.protocol === 'string'` survived ADR-0004 turning the protocol
// into an object: the one branch that mentioned the drive protocol could never fire, so the page had never displayed
// it since. These are the two things about this file that are checkable without a DOM.
describe('the trace page', () => {
  it('stays free of backticks and ${, because it lives in a raw template', () => {
    // The file says so at the top, and nothing enforced it: a backtick in a comment ends `String.raw` early and the
    // failure lands as a TS1005 on whatever line happens to follow, nowhere near the cause.
    expect(PAGE).not.toContain('`')
    expect(PAGE).not.toContain('${')
  })

  it('reads the drive protocol as the object ADR-0004 made it, on the responses that carry one', () => {
    // An arrival and a `describe` are the only responses that carry it; the usage response never does, because a
    // driver handed a child never reaches one.
    expect(PAGE).toContain('rr.protocol.driving')
    expect(PAGE).not.toContain("typeof r.protocol === 'string'")
  })

  it('shows the payload the runtime received, never argv', () => {
    // The stdin form the protocol teaches leaves a bare '-' in argv, so a page that parsed argv showed '-' for most
    // sends of a real run. The entry carries the payload whatever its origin.
    expect(PAGE).toContain('e.payload !== undefined) c.payload = e.payload')
    expect(PAGE).not.toContain('JSON.parse(argv[3])')
  })

  it('embeds a payload that holds $ patterns exactly as sent', () => {
    // Agents send shell text, and `String.replace` with a string reads `$'`, `$&`, `` $` `` and `$$` in it as
    // replacement patterns: the page then showed a payload the agent never sent, or failed to parse at all.
    const text = "echo $$ && grep '$&' a$'b and $`x`"
    const entry: TraceEntry = {
      at: '2026-01-01T00:00:00.000Z', ms: 1, pid: 1, argv: ['send', 'a', 'go', '-'], payload: { text }, exitCode: 0,
      response: { text },
    }
    const html = renderTrace([entry], 'demo')
    const embedded = html.match(/<script id="trace-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1]
    expect(JSON.parse(embedded!)).toEqual({ bin: 'demo', entries: [entry] })
  })
})
