import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assign } from 'xstate'
import { z } from 'zod'
import { backseat, collectChildren, scratchDir } from 'backseat-ai'
import { researchTask, type Source, type TaskReport } from './research-task.ts'

// ---- the lead: decompose, dispatch a worker per sub-task, judge the round, draft and cite ---------------------------

/**
 * A sub-question a worker answered. The summary is in the file, not in the response — and the file's *path* is not
 * here either: it is derived from `actorId` wherever it is published, never stored.
 */
type Finding = { actorId: string; subQuestion: string; sources: Source[] }
/** A sub-question a worker searched and could not answer. Re-issuing it verbatim buys nothing. */
type Unanswerable = { actorId: string; subQuestion: string; reason: string }
/** A worker that broke. Its sub-question was never really tried, so it can be re-commissioned unchanged. */
type Failed = { actorId: string; subQuestion: string; error: string }

type Citation = { claim: string; sourceUrl: string }

type LeadContext = {
  question: string
  maxRounds: number
  round: number
  dispatched: number
  pending: Array<{ subQuestion: string }>
  current: { subQuestion: string } | null
  findings: Finding[]
  unanswerable: Unanswerable[]
  failed: Failed[]
  synthesis: string | null
  draft: string
  citations: Citation[]
  unquoted: string[]
  unreported: string[]
}

type LeadEvent =
  | { type: 'brief.submit'; question: string }
  | { type: 'plan.submit'; subTasks: Array<{ subQuestion: string }> }
  | { type: 'task.next' }
  | { type: 'research.review' }
  | { type: 'round.again'; synthesis: string; gaps: string[] }
  | { type: 'research.conclude'; synthesis: string }
  | { type: 'draft.submit'; draft: string }
  | { type: 'citations.submit'; citations: Citation[] }

const { createMachine, spawnChild } = backseat<LeadContext, LeadEvent>()

// ---- helpers --------------------------------------------------------------------------------------------------

/**
 * Where a worker's finding is written: flat in the run's scratch directory, which the runtime makes before the root's
 * first call and destroys when the root finishes, so the courier is shed with the run that needed it.
 *
 * `actorId` in a collection is the child's *qualified* id — `<rootId>/task-1-1` — not the key `spawnChild` was
 * given, so the last segment is what names a flat file.
 *
 * `scratchDir()` reads the ambient run, so this is only callable *inside a call on an actor* — see `withFiles`.
 */
const findingFile = (actorId: string) => join(scratchDir(), `${actorId.split('/').pop()}.md`)

/**
 * Findings, each with the path of the file its summary is in. Published by the two states whose instructions tell the
 * agent to read them, and by no others — a path is worth nothing to a state that only names the sources.
 *
 * **Derived per finding, deliberately.** `meta.data` is applied to the registration context too, outside any run
 * (`runtime.ts`'s `emitted`), and `scratchDir()` throws there because there is no ambient run to read. It is reached
 * only from inside this callback, which the empty `findings` of that context never enters. Hoisting the directory out
 * of the `map` would fail registration.
 */
const withFiles = (findings: Finding[]) => findings.map((f) => ({ ...f, file: findingFile(f.actorId) }))

/** Take the head of the sub-task queue and number the worker about to be spawned for it. */
const takeTask = ({ context }: { context: LeadContext }) => ({
  current: context.pending[0] ?? null,
  pending: context.pending.slice(1),
  dispatched: context.dispatched + 1,
})

/** A collected child's `output`, narrowed. A worker that broke has none. */
const asReport = (output: unknown): TaskReport | null => {
  if (typeof output !== 'object' || output === null) return null
  const it = output as Partial<TaskReport>
  return typeof it.subQuestion === 'string' && Array.isArray(it.sources) ? (it as TaskReport) : null
}

/** Every URL any worker reported. The set a citation's `sourceUrl` must come from. */
const reportedUrls = (findings: Finding[]) => new Set(findings.flatMap((f) => f.sources.map((s) => s.url)))

/** The spans the draft does not contain, character for character. */
const unquotedIn = (draft: string, citations: Citation[]) =>
  citations.map((c) => c.claim).filter((claim) => !draft.includes(claim))

/** The URLs no worker reported. */
const unreportedIn = (findings: Finding[], citations: Citation[]) => {
  const reported = reportedUrls(findings)
  return citations.map((c) => c.sourceUrl).filter((url) => !reported.has(url))
}

/** The draft with `[[n]](url)` spliced in after each cited span, numbered in the reader's order. */
const citedReport = ({ draft, citations }: LeadContext): string => {
  const marks = citations
    .map(({ claim, sourceUrl }) => ({ at: draft.indexOf(claim), len: claim.length, sourceUrl }))
    .filter(({ at }) => at !== -1)
    .map(({ at, len, sourceUrl }) => ({ end: at + len, sourceUrl }))
    .sort((a, b) => a.end - b.end)
  let out = ''
  let cut = 0
  marks.forEach(({ end, sourceUrl }, i) => {
    out += draft.slice(cut, end) + `[[${i + 1}]](${sourceUrl})`
    cut = end
  })
  return out + draft.slice(cut)
}

/**
 * The half of `citations.submit` that both states share. The `actions` cannot join it: an action written anywhere but
 * in place loses the contextual typing that gives its `event` the transition's payload, so each copy keeps its own.
 */
/**
 * The contract for submitting citations. It lives on `checking`, the state both submissions target, because a schema
 * on a state is the payload required to *enter* it and applies to every transition that targets it — so the two
 * transitions that reach it, from `awaiting` and from `rejected`, share one contract rather than repeating it.
 */
const citationSet = z.object({ claim: z.string().min(10), sourceUrl: z.url() })
const citationsSubmitted = z.object({ citations: z.array(citationSet) })

/**
 * The guards, hoisted so they have names. An arrow written straight into `guard:` is named after that property — so
 * every such guard is called "guard" — and the run record identifies a contested transition by its guard's name. A
 * const is the only way to say which one ran.
 */
const hasPending = ({ context }: { context: LeadContext }) => context.pending.length > 0
const queueDrained = ({ context }: { context: LeadContext }) => context.pending.length === 0
const withinBudget = ({ context }: { context: LeadContext }) => context.round < context.maxRounds
const citationsHold = ({ context }: { context: LeadContext }) =>
  context.unquoted.length === 0 &&
  context.unreported.length === 0 &&
  (context.citations.length > 0 || reportedUrls(context.findings).size === 0)

export const deepResearch = createMachine({
  id: 'deepResearch',
  description:
    'Research a question end to end: decompose it into sub-tasks, dispatch a worker per sub-task, judge whether ' +
    'the answer is complete, then draft and cite a report.',
  actors: { researchTask },
  context: () => ({
    question: '',
    maxRounds: 3,
    round: 0,
    dispatched: 0,
    pending: [],
    current: null,
    findings: [],
    unanswerable: [],
    failed: [],
    synthesis: null,
    draft: '',
    citations: [],
    unquoted: [],
    unreported: [],
  }),
  output: ({ context }) => ({ report: citedReport(context), citations: context.citations }),
  initial: 'briefing',
  states: {
    briefing: {
      description: 'The research question is being stated.',
      instructions: 'State the research question verbatim as you were given it.',
      on: {
        'brief.submit': {
          target: 'planning',
          description: 'The question is stated.',
          schema: z.object({ question: z.string().min(10) }),
          actions: assign({ question: ({ event }) => event.question }),
        },
      },
    },

    planning: {
      description: 'The question is known; this round needs sub-tasks.',
      // The round about to be planned and the budget of rounds.
      data: ({ context }) => ({ round: context.round + 1, maxRounds: context.maxRounds }),
      instructions: ({ visit }) =>
        visit === 'first'
          ? 'You are planning round `data.round` of at most `data.maxRounds`. Start broad: a first round maps the ' +
            'ground — which candidates, sources and angles exist — rather than trying to settle the answer, and ' +
            'later rounds add depth aimed at what it turns up. List the sub-tasks to commission this round, at most ' +
            '10: every one you list runs. Each must be self-contained: a worker ' +
            'sees the research question and its own sub-question, nothing else, and cannot ask you for ' +
            'clarification. State an objective and clear boundaries so two workers do not duplicate each other. ' +
            'Write every boundary in terms the worker can check alone: name the topic it must not cover, never ' +
            'point at another sub-task it cannot see.'
          : 'You are planning round `data.round` of at most `data.maxRounds`. List the sub-tasks to commission, at ' +
            'most 10; every one you list runs. Go deeper than the rounds ' +
            'before it: aim each sub-task at the ' +
            'gaps you named and at the specific candidates or sources the earlier findings surfaced, naming them ' +
            'so a worker can check them alone, and ask for what the answer turns on to be confirmed at its ' +
            'source. Do not re-commission work already reported. Boundaries still have to be checkable by a ' +
            'worker that sees the question and its own sub-question, and no other sub-task.',
      on: {
        'plan.submit': {
          target: 'researching',
          description: 'The round has its sub-tasks.',
          schema: z.object({
            subTasks: z.array(z.object({ subQuestion: z.string().min(10) })).min(1).max(10),
          }),
          actions: assign(({ context, event }) => ({
            round: context.round + 1,
            dispatched: 1,
            pending: event.subTasks.slice(1),
            current: event.subTasks[0] ?? null,
          })),
        },
      },
    },

    researching: {
      description: 'Workers are being dispatched and are running.',
      // No `data`: the queue is the machine's, and the lead has nothing to act on until the round is in.
      instructions: ({ visit }) =>
        visit === 'first'
          ? 'Every sub-task you listed runs this round, in the order you gave. For each one, spawn a subagent ' +
            'and tell it to run the listed command: each worker\'s searches and pages then stay out of your context, ' +
            'and the workers run side by side. Keep dispatching while another sub-task is offered, then wait until ' +
            'all of your subagents are complete before moving to review.'
          : 'Dispatch while another sub-task is offered; otherwise wait until all of your subagents are complete, ' +
            'then move to review.',
      // `input` is the child's. `about` is this lead's own note on this one worker — the sub-question it was
      // handed — and is the only thing that still says what a worker that broke was for.
      entry: spawnChild('researchTask', {
        id: ({ context }) => `task-${context.round}-${context.dispatched}`,
        about: ({ context }) => context.current?.subQuestion ?? '(no sub-question)',
        input: ({ context }) => ({
          subQuestion: context.current?.subQuestion ?? '',
          question: context.question,
        }),
      }),
      on: {
        'task.next': {
          guard: hasPending,
          target: 'researching',
          reenter: true,
          description: 'Another sub-task is waiting to be dispatched.',
          actions: assign(takeTask),
        },
        // Two events, not one contested `task.next`: the dispatch is offered while the queue holds a sub-task, the
        // review once it is drained, so the offered list reads as one move at a time.
        'research.review': {
          guard: queueDrained,
          target: 'reviewing',
          description: 'Every sub-task is dispatched and every worker is back.',
          actions: collectChildren(
            'researching',
            'researchTask',
            assign(({ context, event }) => {
              const findings = [...context.findings]
              const unanswerable = [...context.unanswerable]
              const failed = [...context.failed]
              for (const site of event.settled)
                for (const child of site.children) {
                  const report = child.status === 'done' ? asReport(child.output) : null
                  if (!report)
                    failed.push({
                      actorId: child.actorId,
                      subQuestion: String(child.about ?? '(unrecorded)'),
                      error: String(child.error ?? `worker ${child.status}`),
                    })
                  else if (report.unanswerable !== null)
                    unanswerable.push({
                      actorId: child.actorId,
                      subQuestion: report.subQuestion,
                      reason: report.unanswerable,
                    })
                  else
                    findings.push({
                      actorId: child.actorId,
                      subQuestion: report.subQuestion,
                      sources: report.sources,
                    })
                }
              return { findings, unanswerable, failed }
            }),
            // The summaries go to files the lead's driver opens; only their sources enter context. They come after the
            // `assign`: a throw there discards the round, and files already written would outlive it.
            ({ event }) => {
              for (const site of event.settled)
                for (const child of site.children) {
                  const report = asReport(child.output)
                  if (!report?.summary) continue
                  writeFileSync(
                    findingFile(child.actorId),
                    `# ${report.subQuestion}\n\n${report.summary}\n\n${report.sources
                      .map((s) => `- [${s.title}](${s.url})`)
                      .join('\n')}\n`,
                  )
                }
            },
          ),
        },
      },
    },

    reviewing: {
      description: 'Every worker in this round has reported.',
      data: ({ context: { question, round, maxRounds, findings, unanswerable, failed } }) =>
        ({ question, round, maxRounds, findings: withFiles(findings), unanswerable, failed }),
      instructions: ({ visit }) =>
        visit === 'first'
          ? 'Synthesize the findings your workers wrote, each in the file named in `data.findings`, into a short ' +
          'account of what is now known. Then judge it against `data.question`, the research question you stated ' +
          'at the start: does the account answer it, or do material gaps remain? `data.round` is the round that ' +
          'just finished, of a budget of `data.maxRounds`. An early round is meant to be broad, so candidates or claims it surfaced but did not ' +
          'examine closely, or that rest on second-hand figures, are gaps: another round adds that depth while ' +
          'your budget allows. Two kinds of gap are named for ' +
          'you. `data.unanswerable` lists the sub-questions a worker searched and could not answer, each with ' +
          'the reason it gave: that sub-question went unresearched, and re-issuing it as it stands will not ' +
          'change the answer — re-cut it or drop it, and say in your synthesis what is not known. `data.failed` ' +
          'lists the workers that broke; their sub-questions went unresearched too, but were never really tried, ' +
          'so those can be re-commissioned unchanged. If nothing at all came back, say so plainly in your ' +
          'synthesis rather than writing around it, and call another round while your budget allows.'
          : 'Round `data.round` is in. Synthesize `data.findings` again against `data.question`, and account for ' +
          '`data.unanswerable` and `data.failed`. What surfaced without being examined closely is still a gap.',
      on: {
        'round.again': {
          guard: withinBudget,
          target: 'planning',
          description: 'Material gaps remain.',
          // `gaps` is stated, not stored: naming them is the price of another round, and nothing keeps them.
          schema: z.object({
            synthesis: z.string().min(80),
            gaps: z.array(z.string().min(10)).min(1),
          }),
          actions: assign({ synthesis: ({ event }) => event.synthesis }),
        },
        'research.conclude': {
          target: 'drafting',
          description: 'The reports are sufficient to write from.',
          actions: assign({ synthesis: ({ event }) => event.synthesis }),
        },
      },
    },

    drafting: {
      description: 'The research is settled and needs writing up.',
      // What it takes to get here at all: the synthesis the lead must have written before it may draft. On the state
      // rather than on `research.conclude`, so any later way in carries the same contract.
      schema: z.object({ synthesis: z.string().min(80) }),
      data: ({ context: { question, findings } }) => ({ question, findings: withFiles(findings) }),
      instructions: ({ visit }) =>
        visit === 'first'
          ? 'Write the report body from your synthesis and the findings in the files named in `data.findings`. It ' +
          'is answering `data.question`, the research question you stated at the start. If `data.findings` is ' +
          'empty, no worker reported anything: write what the synthesis says could not be established, and say ' +
          'so plainly rather than writing around it. Do not attach citations yet; that is a separate pass.'
          : 'Write the report body for `data.question` from `data.findings`. Citations come after.',
      on: {
        'draft.submit': {
          target: 'citing',
          description: 'The report body is written.',
          schema: z.object({ draft: z.string().min(200) }),
          actions: assign({ draft: ({ event }) => event.draft }),
        },
      },
    },

    // The citation pass, as the spec models it: one compound state holding the submit/check/reject loop, left only
    // when a submission holds. A `target` names a sibling, so nothing inside here can name `complete` — but `onDone`
    // is written on `citing` itself, where the siblings are the root's states, and `complete` is one of them. A
    // `final` child finishes the region and `onDone` carries the actor out. That is the ordinary XState way out of a
    // compound state, and it is why the grouping does not have to be given up: the earlier flattening was worked
    // around a rule that had been applied at one door and not the other three.
    citing: {
      description: 'The draft is written and its citations are being attached.',
      initial: 'awaiting',
      // The way out. Reached when `accepted` is entered, and the only exit from this region.
      onDone: { target: 'complete' },
      states: {
        awaiting: {
          description: 'A set of citations is being chosen for the draft.',
          data: ({ context: { draft, findings } }) => ({ draft, findings }),
          instructions: ({ visit }) =>
            visit === 'first'
              ? 'Cite the key facts and conclusions `data.draft` rests on, not every sentence. Each citation pairs ' +
              'a `claim` — a span copied verbatim out of `data.draft`, character for character — with a ' +
              '`sourceUrl` drawn from the sources in `data.findings`. Quote a whole sentence where you can: the ' +
              'marker lands at the end of the span. The check is provenance, not support. The draft is final ' +
              'and this machine splices the markers into it, so do not rewrite it. If `data.findings` is empty ' +
              'there is nothing to cite, and an empty set is the submission to make.'
              : 'Pair verbatim spans of `data.draft` with source URLs from `data.findings`.',
          on: {
            'citations.submit': {
              target: 'checking',
              description: 'The citations are submitted as a set.',
              actions: assign(({ context, event }) => ({
                citations: event.citations,
                unquoted: unquotedIn(context.draft, event.citations),
                unreported: unreportedIn(context.findings, event.citations),
              })),
            },
          },
        },

        // A branch state, not a resting place: the two tests depend on context a schema never sees, and the citations
        // are not in context until the assign above has run, so neither can be a guard on `citations.submit`.
        checking: {
          description: 'The submission is being checked against the draft and the reported sources.',
          schema: citationsSubmitted,
          always: [
            {
              guard: citationsHold,
              target: 'accepted',
              description: 'Every span is in the draft and every URL was reported.',
            },
            { target: 'rejected', description: 'The submission does not hold.' },
          ],
        },

        // Entering this is what finishes the region, which is what `onDone` above carries out to `complete`.
        accepted: { type: 'final', description: 'The submission holds and the markers are the draft\'s.' },

        // The loop back to `checking` is unbounded on purpose. It corrects a submission rather than redoing work: each
        // rejection names every span and URL to fix, and a set that holds (any verbatim span, any reported URL) is
        // always within the agent's reach, so a bound would only add a way to end uncited.
        rejected: {
          description: 'The last submission does not hold as a set, and the draft is still uncited.',
          data: ({ context: { draft, findings, unquoted, unreported } }) => ({ draft, findings, unquoted, unreported }),
          instructions: ({ visit }) =>
            visit === 'first'
              ? 'Nothing was attached. `data.unquoted` names the spans `data.draft` does not contain — copy those ' +
              'again out of `data.draft`, character for character. `data.unreported` names the URLs no worker ' +
              'reported — replace each with one from `data.findings`. Resubmit the whole set; a set of citations ' +
              'is applied or none of it is. If both lists are empty, the submission was empty while ' +
              '`data.findings` still names sources, which is the one rejection neither list can describe.'
              : 'Fix `data.unquoted` and `data.unreported` and resubmit the whole set.',
          on: {
            'citations.submit': {
              target: 'checking',
              description: 'The citations are submitted as a set.',
              actions: assign(({ context, event }) => ({
                citations: event.citations,
                unquoted: unquotedIn(context.draft, event.citations),
                unreported: unreportedIn(context.findings, event.citations),
              })),
            },
          },
        },
      },
    },

    complete: {
      type: 'final',
      description: 'The report is written and cited.',
      instructions: 'You are done. The report you drafted and cited is delivered to whoever handed you this tool; they ' +
          'read it from this actor, not from you, and nothing further is offered here. Tell them this actor is ' +
          'complete, give them its id, and stop.',
    },
  },
})
