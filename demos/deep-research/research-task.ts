import { assign } from 'xstate'
import { z } from 'zod'
import { backseat, RejectedEvent } from 'backseat-ai'

// ---- the worker: one research sub-task, driven by one subagent -----------------------------------------------------

export type Source = { url: string; title: string }

/** What a worker hands back on its done event. `summary` and `unanswerable` are the two exits, never both. */
export type TaskReport = {
  subQuestion: string
  summary: string | null
  sources: Source[]
  unanswerable: string | null
}

const source = z.object({ url: z.url(), title: z.string().min(1) })

type TaskInput = { subQuestion: string; question: string }

type TaskContext = {
  question: string
  subQuestion: string
  pending: string[]
  current: string | null
  summary: string | null
  sources: Source[]
  unanswerable: string | null
}

type TaskEvent =
  | { type: 'queries.submit'; queries: string[] }
  | { type: 'queries.add'; queries: string[] }
  | { type: 'search.results'; query: string }
  | { type: 'search.resume'; queries: string[] }
  | { type: 'finding.submit'; summary: string; sources: Source[] }
  | { type: 'finding.empty'; reason: string }

const { createMachine, withCheckInput } = backseat<TaskContext, TaskEvent, TaskInput>()

/** Take the head of the queue. The agent never sees the queue, only the query in hand. */
const takeNext = ({ context }: { context: TaskContext }) => ({
  current: context.pending[0] ?? null,
  pending: context.pending.slice(1),
})

/** Hoisted for its name: an arrow written into `guard:` is named after the property, so the record cannot tell the
 * two `search.results` branches apart. */
const queueDrained = ({ context }: { context: TaskContext }) => context.pending.length === 0

export const researchTask = createMachine({
  id: 'researchTask',
  description: 'A single research sub-task: turn one sub-question into a written finding backed by sources.',
  context: withCheckInput(
    ({ input }) => ({
      question: input.question,
      subQuestion: input.subQuestion,
      pending: [],
      current: null,
      summary: null,
      sources: [],
      unanswerable: null,
    }),
    { subQuestion: 'A sample sub-question.', question: 'A sample research question.' },
  ),
  output: ({ context }): TaskReport => ({
    subQuestion: context.subQuestion,
    summary: context.summary,
    sources: context.sources,
    unanswerable: context.unanswerable,
  }),
  initial: 'briefing',
  states: {
    briefing: {
      description: 'The sub-question is being turned into search queries.',
      data: ({ context: { question, subQuestion } }) => ({ question, subQuestion }),
      instructions: ({ visit }) =>
        visit === 'first'
          ? 'You have been handed this actor for `data.subQuestion`. Propose 2-5 search queries that together ' +
          'answer it. Each must stand alone as a search string. `data.question` is the research question your ' +
          'sub-question was cut from: it is there so you know what your finding will be read for, and is not ' +
          'yours to answer.'
          : 'Propose 2-5 standalone search queries for `data.subQuestion`.',
      on: {
        'queries.submit': {
          target: 'searching',
          description: 'The queries are chosen.',
          schema: z.object({ queries: z.array(z.string().min(3)).min(2).max(5) }),
          actions: assign({ pending: ({ event }) => event.queries }),
        },
      },
    },

    searching: {
      description: 'Queries are being worked one at a time.',
      // Entering hands out the first query; each report hands out the next. `current` is never null here.
      entry: assign(takeNext),
      data: ({ context: { current } }) => ({ current }),
      instructions: ({ visit }) =>
        visit === 'first'
          ? 'You are handed one query at a time as `data.current`. Run it with whatever web search you have — ' +
          'this workflow provides none — read the hits yourself, and report the query done, naming the query ' +
          'you ran; the response hands you the next one. Keep what you find: you write the ' +
          'finding from it at the end and nothing here stores it for you. A query that returns nothing is still a ' +
          'query run — report it rather than inventing a result. If reading the hits surfaces a further query, ' +
          'add it to the queue. Answer the sub-question thoroughly: where a hit bears on it, read the page itself ' +
          'rather than the snippet, and if a page refuses you, try any other way you have of fetching it before ' +
          'settling for the snippet. Keep note of which facts came from snippets alone. When the last query is ' +
          'reported you will be moved on.'
          : 'Run `data.current` and report it done, naming the query.',
      on: {
        'search.results': [
          {
            guard: queueDrained,
            target: 'summarizing',
            description: 'That was the last query.',
            schema: ({ current }) => z.object({ query: z.literal(current ?? '') }),
            actions: assign({ current: () => null }),
          },
          {
            description: 'Another query is waiting.',
            schema: ({ current }) => z.object({ query: z.literal(current ?? '') }),
            actions: assign(takeNext),
          },
        ],
        'queries.add': {
          description: 'The hits surfaced a query worth running.',
          schema: z.object({ queries: z.array(z.string().min(3)).min(1) }),
          actions: assign({ pending: ({ context, event }) => [...context.pending, ...event.queries] }),
        },
      },
    },

    summarizing: {
      description: 'Every query has been answered; the sub-task needs a written finding.',
      // The sub-question was last shown at `briefing`; `searching` shows only the query in hand.
      data: ({ context: { question, subQuestion } }) => ({ question, subQuestion }),
      instructions: ({ visit }) =>
        visit === 'first'
          ? 'Write a finding that answers `data.subQuestion` from the hits you gathered, listing only the sources ' +
          'you actually drew on. `data.question` is the research question it was cut from: it tells you what the ' +
          'finding will be read for, not what to answer. If the hits are too thin, or what the finding turns on ' +
          'rests on snippets you could still read at the source, resume the search with further queries instead. ' +
          'Say in the finding which facts came from snippets alone. If you have searched and nothing you found ' +
          'supports an answer, say so and give the reason: do not pad a finding out, and do not list a source you ' +
          'would not stand behind. A stated absence is worth more to the lead than a finding you do not believe.'
          : 'Conclude on `data.subQuestion`: write the finding, say that nothing supports an answer, or resume ' +
          'the search.',
      on: {
        'finding.submit': {
          target: 'complete',
          description: 'The sub-question is answered.',
          schema: z.object({ summary: z.string().min(80), sources: z.array(source).min(1) }),
          // The sources are checked at the source: a run once accepted a citation its own title called "page 404'd".
          // Only a page the server says is gone is refused; any other status, and any failure to reach it, passes,
          // since a page that blocks bots is not a page that is gone. Some servers answer HEAD with 404 and GET with the
          // page, so a HEAD that says gone is confirmed with a GET.
          effect: async ({ event }) => {
            const statusOf = (url: string, method: 'HEAD' | 'GET') =>
              fetch(url, { method, signal: AbortSignal.timeout(10_000) }).then(
                (res) => (res.body?.cancel(), res.status),
                () => 0,
              )
            const gone = await Promise.all(
              event.sources.map(async ({ url }) => {
                const head = await statusOf(url, 'HEAD')
                const status = head === 404 || head === 410 ? await statusOf(url, 'GET') : head
                return status === 404 || status === 410
                  ? `${url} is gone (HTTP ${status}). Cite the page you read instead, or drop it and say what rested on it.`
                  : null
              }),
            )
            const reasons = gone.filter((reason) => reason !== null)
            if (reasons.length > 0) throw new RejectedEvent(reasons.join('\n'))
          },
          actions: assign({ summary: ({ event }) => event.summary, sources: ({ event }) => event.sources }),
        },
        'finding.empty': {
          target: 'complete',
          description: 'Nothing found supports an answer.',
          schema: z.object({ reason: z.string().min(80) }),
          actions: assign({ unanswerable: ({ event }) => event.reason }),
        },
        'search.resume': {
          target: 'searching',
          description: 'The hits do not yet answer it.',
          schema: z.object({ queries: z.array(z.string().min(3)).min(1) }),
          actions: assign({ pending: ({ context, event }) => [...context.pending, ...event.queries] }),
        },
      },
    },

    complete: {
      type: 'final',
      description: 'The sub-task is finished, with a finding or a stated absence.',
      instructions: 'The result is reported to the lead. Nothing further is asked of you here.',
    },
  },
})
