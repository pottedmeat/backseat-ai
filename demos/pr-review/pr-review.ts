import { assign } from 'xstate'
import { z } from 'zod'
import { backseat } from 'backseat-ai'

// ---- what the agent tells the machine ------------------------------------------------------------------------------
//
// The machine has no network and no shell. Every fact below reached context because a driver sent it, under ADR-0009:
// the machine names an act the driver performs with its own tools and specifies exactly what must come back.

type Pr = { url: string; title: string; baseRef: string; headRef: string; changedFiles: number }
type Gap = { where: string; what: string }
type Check = { check: string; passed: boolean; output: string }

// Every field here is read by something: a guard, a context-derived schema, a state's `data`, or the root's
// `output`. A value the agent sent and nothing reads again is not context, it is a museum — the agent still has it,
// and storing it only makes the record look like the machine knows something it does not.
type PrReviewContext = {
  pr: Pr | null
  /** Every check triage or a build round has named, read by `build.submit`'s schema so each round reports on all of them. */
  namedChecks: string[]
  checks: Check[]
  changed: string[]
  concerns: Gap[]
  /** What the last review looked at. Not `checked`: one letter from `checks`, and the agent would fill it with those. */
  reviewed: string[]
  rounds: number
  /** How the run ended, once it has. Five ways out, and only one of them is the work being done. */
  outcome: Outcome | null
  /** Why it ended that way. Null only for `complete`, where the checks and `reviewed` are the reason. */
  why: string | null
}

/** One per ending, under the ending's own name — `closed` would read as a pull request closed unmerged. */
type Outcome = 'complete' | 'clean' | 'unreachable' | 'exhausted' | 'blocked'

type PrReviewEvent =
  | { type: 'pr.verified'; url: string; title: string; baseRef: string; headRef: string; changedFiles: number }
  | { type: 'pr.unreachable'; why: string }
  | { type: 'triage.gaps'; intent: string; gaps: Gap[]; checks: Check[] }
  | { type: 'triage.clean'; reviewed: string[]; checks: Check[]; why: string }
  | { type: 'triage.blocked'; concerns: Gap[]; why: string }
  | { type: 'build.submit'; changed: string[]; checks: Check[] }
  | { type: 'build.blocked'; concerns: Gap[]; why: string }
  | { type: 'review.concerns'; reviewed: string[]; concerns: Gap[] }
  | { type: 'review.clear'; reviewed: string[] }
  | { type: 'review.exhausted'; reviewed: string[]; concerns: Gap[]; why: string }
  | { type: 'review.blocked'; reviewed: string[]; concerns: Gap[]; why: string }

const gap = z.object({
  where: z.string().min(1).describe('where it is'),
  what: z.string().min(1).describe('what is wrong there'),
})

// One check as the agent reports it: its name is the key every later round is held to, and `output` is the artefact
// that proves it ran. `output` may be empty text — a check with no output is plausible, a missing field is not.
const check = z.object({
  check: z.string().min(1).describe('the check, named the way you ran it'),
  passed: z.boolean(),
  output: z.string().describe('what it returned, which may be nothing'),
})

// What every way out of `reviewing` but the close carries. Every door requires a non-empty `reviewed`, so there is no
// leaving that state without saying what was looked at.
const findings = z.object({
  reviewed: z.array(z.string().min(1)).min(1).describe('what you reviewed this round'),
  concerns: z.array(gap).min(1).describe('what is still wrong'),
})

// The act that closes out every ending that reached the pull request, with only the summary differing. What the
// agent built reaches the pull request as suggestions on the lines it changed, never as a commit: the changes exist
// only in its working copy, and the author decides what lands. A suggestion can only sit on a line inside the diff,
// and triage's own gaps — a call site the change did not reach, a test that does not exist — produce changes
// outside it, so the patch is named as the form for those. "Any change", because from `triaging` there may be none.
const leaveReview = (summary: string) =>
  'Leave your review on the pull request: any change you made inside the diff as a suggestion on the lines it ' +
  'touches, so the author can apply it, any change to a file or line the pull request did not touch as a patch in ' +
  `your summary, since a suggestion cannot be attached there, and a summary of ${summary} Commit nothing to the branch.`

// The first of the machine's three guards, and the one thing here it genuinely knows: the agent already reported
// whether the last round's checks passed, so closing over a red one is refused rather than asked about. Hoisted for
// its name — an arrow written straight into `guard:` is named "guard" by JavaScript, and the run record identifies a
// contested transition by its guard's name.
const checksPassed = ({ context }: { context: PrReviewContext }) => context.checks.every((check) => check.passed)

// A build-review loop with no bound can go round forever, and an agent that cannot fix a thing in five rounds is not
// going to fix it in fifty. At the bound the loop is not simply closed off — that would strand the agent in
// `reviewing` with nothing to send — so `review.exhausted` opens as `review.concerns` shuts.
const MAX_ROUNDS = 5
const withinBudget = ({ context }: { context: PrReviewContext }) => context.rounds < MAX_ROUNDS
const budgetSpent = ({ context }: { context: PrReviewContext }) => context.rounds >= MAX_ROUNDS

const { createMachine } = backseat<PrReviewContext, PrReviewEvent>()

export const prReview = createMachine({
  id: 'prReview',
  description: 'Work a pull request to a verified close: confirm it, find what is missing, fix it, check it.',
  context: {
    pr: null,
    namedChecks: [],
    checks: [],
    changed: [],
    concerns: [],
    reviewed: [],
    rounds: 0,
    outcome: null,
    why: null,
  },
  output: ({ context }) => ({
    pr: context.pr,
    rounds: context.rounds,
    changed: context.changed,
    checks: context.checks,
    reviewed: context.reviewed,
    outcome: context.outcome,
    why: context.why,
    concerns: context.concerns,
  }),
  initial: 'validating',
  states: {
    validating: {
      description: 'The pull request is being opened and identified.',
      // Says only what the schema cannot: why the identity is wanted. The fields themselves are the schema's to state,
      // and the response renders it directly beneath this prose — enumerating them here said everything twice.
      instructions:
        'You are reviewing a pull request. Before anything else, open the one you were given and send back its ' +
        'identity. A pull request you cannot open is not one you can review, and the file count is how ' +
        'this workflow knows you opened it rather than echoed back the url.',
      on: {
        // Without this the machine has no way to fail: an agent that cannot open the pull request is asked for an
        // identity it has not got, forever. The only state that can be entered without the work having started.
        'pr.unreachable': {
          target: 'unreachable',
          description: 'The pull request cannot be opened, and there is nothing to review.',
          schema: z.object({
            why: z.string().min(1).describe('what happened when you tried to open it — the error, the status, or what was missing'),
          }),
          actions: assign({ why: ({ event }) => event.why }),
        },
        'pr.verified': {
          target: 'triaging',
          description: 'The pull request opened and its identity is in hand.',
          // `changedFiles` is `.min(1)` because a pull request that changes nothing is not reviewable, and the count is
          // the cheapest artefact that proves the diff was fetched rather than the url echoed back.
          schema: z.object({
            url: z.url().describe('the pull request you opened'),
            title: z.string().min(1).describe('its title, as the pull request gives it'),
            baseRef: z.string().min(1).describe('the branch it merges into'),
            headRef: z.string().min(1).describe('the branch it comes from'),
            changedFiles: z.number().int().min(1).describe('how many files its diff touches'),
          }),
          actions: assign({
            pr: ({ event }) => ({
              url: event.url,
              title: event.title,
              baseRef: event.baseRef,
              headRef: event.headRef,
              changedFiles: event.changedFiles,
            }),
          }),
        },
      },
    },

    triaging: {
      description: 'The change is being read for what it is missing.',
      // Says only what the schema cannot: how concrete a gap has to be. What a gap is, the `gaps` field says. The
      // checks are run here because `triage.clean` is the one path that approves, and an approval over a suite
      // nobody ran is the claim this machine exists to refuse; on the other path their names are what every build
      // round is then held to re-run.
      instructions:
        'Read the diff and the code around it, run its checks, and decide whether anything is missing. Name each ' +
        'gap concretely enough to act on without asking you a question.',
      on: {
        'triage.gaps': {
          target: 'building',
          description: 'Something is missing, and it can be fixed from here.',
          schema: z.object({
            intent: z.string().min(1).describe('what this pull request is trying to do'),
            gaps: z
              .array(gap)
              .min(1)
              .describe(
                'what is missing: a line the diff gets wrong, a call site the change did not reach, a case the diff ' +
                  'does not handle, a test that should exist and does not, a check that fails',
              ),
            checks: z.array(check).describe('every check the pull request has, run, passed or not; empty if it has none'),
          }),
          // The intent and the gaps are not kept: nothing downstream reads them, and the agent still has both. The
          // check names are, because `build.submit`'s schema is derived from them — the suite triage ran is what every
          // build round is held to re-run. Empty is allowed: a pull request may have no checks, and demanding one here
          // would be a fabricated payload.
          actions: assign({ namedChecks: ({ event }) => event.checks.map((check) => check.check) }),
        },
        // The empty-triage route, and an ending rather than a detour: with nothing to build there is nothing for
        // `building` or `reviewing` to work on, and sending the agent on asks it to fix and check work that does
        // not exist. It leaves from here because `triaging` is never revisited: a round that happened and left
        // concerns can never reach this door, so no guard has to hide it. `reviewed` and `checks` are required
        // because this is the one path that approves: every other close is held to check output, and without them
        // the record would carry an approval over nothing looked at and nothing run. `passed` is the literal `true`
        // — a red check is a gap, and its door is `triage.gaps`. `checks` may be empty, as on `triage.gaps`: this
        // machine refuses to close over a failing check, and a pull request with no checks has none failing.
        'triage.clean': {
          target: 'clean',
          description: 'Nothing needs changing, so the pull request is already done.',
          schema: z.object({
            reviewed: z.array(z.string().min(1)).min(1).describe('what you reviewed to conclude that'),
            checks: z
              .array(check.extend({ passed: z.literal(true) }))
              .describe('every check the pull request has, run and green; empty if it has none'),
            why: z.string().min(1).describe('why the pull request needs no changes'),
          }),
          actions: assign({
            reviewed: ({ event }) => event.reviewed,
            checks: ({ event }) => event.checks,
            why: ({ event }) => event.why,
          }),
        },
        // The way out for what triage finds and cannot fix: checks that will not run here, or a gap only the author
        // can decide. Without it both had to be sent as a gap, to be abandoned one call later at `build.blocked` — a
        // fabricated payload to record something known here.
        'triage.blocked': {
          target: 'blocked',
          description: 'Something is wrong that you cannot fix from here, or the checks will not run.',
          schema: z.object({
            concerns: z.array(gap).min(1).describe('what is wrong, left as it is'),
            why: z.string().min(1).describe('what stops you from fixing it, and who could remove that'),
          }),
          actions: assign({ concerns: ({ event }) => event.concerns, why: ({ event }) => event.why }),
        },
      },
    },

    building: {
      description: 'What is missing is being fixed and the checks run.',
      entry: assign({ rounds: ({ context }) => context.rounds + 1 }),
      // What to do when the fix cannot be made is `build.blocked`'s description to say, listed beneath this on
      // arrival. There is no plan step between naming a gap and fixing it: a gap is named concretely enough to act
      // on, and a plan the machine could not read back would only have restated it.
      instructions: ({ visit }) =>
        visit === 'first'
          ? 'Fix the gaps you just named, in a working copy so the checks can run; commit nothing, since what ' +
            'reaches the pull request is decided at the end. Report a check that failed as a check that failed: ' +
            'a red check is a result this workflow knows how to handle.'
          : 'Review sent this back. Fix the concerns you recorded, the same way.',
      on: {
        'build.submit': {
          target: 'reviewing',
          description: 'The round is built and its checks have been run.',
          // Derived from context so the contract names the run's own checks, and the refinement demands every one of
          // them, passed or not — saying which are missing, since the message is the whole value of a refusal. A
          // check this round added is welcome, and once reported it is held to like the rest. At registration
          // nothing has been named yet, so the contract asks only that something was run.
          schema: ({ namedChecks }) =>
            z
              .object({
                changed: z.array(z.string().min(1)).min(1).describe('the files you actually changed'),
                checks: z
                  .array(check)
                  .min(1)
                  .describe(
                    namedChecks.length
                      ? `every check named in this run — ${namedChecks.map((name) => `"${name}"`).join(', ')} — and any this round added`
                      : 'every check you ran',
                  ),
              })
              .superRefine((payload, ctx) => {
                const missing = namedChecks.filter((name) => !payload.checks.some((reported) => reported.check === name))
                if (missing.length)
                  ctx.addIssue({
                    code: 'custom',
                    path: ['checks'],
                    message: `not reported: ${missing.map((name) => `"${name}"`).join(', ')}. Report every check named in this run, passed or not.`,
                  })
              }),
          // `changed` and `namedChecks` accumulate: `output` carries `changed` as the record of every file the run
          // touched, and a round that leaves a file alone has not un-changed it; a check any round has reported is
          // one every later round is held to, so a red one cannot be dropped and closed over. `checks` is the last
          // round's, which is what the close is held to.
          actions: assign({
            changed: ({ context, event }) => [...new Set([...context.changed, ...event.changed])],
            namedChecks: ({ context, event }) => [...new Set([...context.namedChecks, ...event.checks.map((check) => check.check)])],
            checks: ({ event }) => event.checks,
          }),
        },
        // An ending, not a detour through `reviewing`: a fix that could not be made — no write access, a branch that
        // will not check out, a check that will not run — or one that turns out not to be the agent's to make, a
        // public API removed with no deprecation, a design the author has to decide — leaves nothing for review to
        // look at, and sending it there asks the agent to check work that does not exist. Requiring a change of at
        // least one file above is what makes this door necessary: an agent that changed nothing has nowhere else
        // honest to go. `concerns` is required because the triage's gaps were not kept, and without it the record
        // would end on nothing. A check known not to run before any fix was tried is `triage.blocked`'s, not this
        // door's.
        'build.blocked': {
          target: 'blocked',
          description: 'The fix is not yours to make, or cannot be made from here.',
          schema: z.object({
            concerns: z.array(gap).min(1).describe('what is missing, left as it was'),
            why: z.string().min(1).describe('what stops you, and who could remove that'),
          }),
          actions: assign({ concerns: ({ event }) => event.concerns, why: ({ event }) => event.why }),
        },
      },
    },

    reviewing: {
      description: 'The round is being checked for whether it can close.',
      // No `data`, here or anywhere: everything a state could publish, this driver sent one call earlier and has not
      // lost, and the round count the machine keeps for its guards is one the driver can count for itself.
      // "In your working copy", because the pull request itself has not changed: building commits nothing, so an
      // agent told to check the pull request would re-fetch an unchanged diff.
      instructions: ({ visit }) =>
        visit === 'first'
          ? 'Check the change as it now stands in your working copy: the diff, the tests, and the code around them.'
          : 'Another round is in. Check it the same way and decide again.',
      on: {
        'review.concerns': {
          target: 'building',
          guard: withinBudget,
          description: 'Something is still wrong, and there are rounds left to fix it.',
          schema: findings,
          actions: assign({
            reviewed: ({ event }) => event.reviewed,
            concerns: ({ event }) => event.concerns,
          }),
        },
        // The same news at the bound, and the only honest thing left: the concerns are recorded and the run ends
        // saying so, rather than closing over them or looping on them.
        'review.exhausted': {
          target: 'exhausted',
          guard: budgetSpent,
          description: 'Something is still wrong and the rounds are used up.',
          schema: findings.extend({
            why: z.string().min(1).describe('why the rounds were not enough — what is left, and what it would take'),
          }),
          actions: assign({
            reviewed: ({ event }) => event.reviewed,
            concerns: ({ event }) => event.concerns,
            why: ({ event }) => event.why,
          }),
        },
        // The way out for an agent that built a round and found what remains is outside its control — a fix only the
        // author can decide, a dependency nobody here can change. Unguarded, because looping to the bound over a thing
        // it cannot change is rounds of token fixes. Not `exhausted`: that says the rounds ran out, and this says
        // they would not have helped. A fix that could not be made at all leaves by `build.blocked` instead, and what
        // triage found it could not fix leaves by `triage.blocked` before a fix is tried.
        'review.blocked': {
          target: 'blocked',
          description: 'Something is still wrong that you cannot fix from here.',
          schema: findings.extend({
            why: z.string().min(1).describe('what stops you from fixing it, and who could remove that'),
          }),
          actions: assign({
            reviewed: ({ event }) => event.reviewed,
            concerns: ({ event }) => event.concerns,
            why: ({ event }) => event.why,
          }),
        },
        'review.clear': {
          target: 'complete',
          description: 'Nothing is left wrong and every check the last round ran is green.',
          // A context guard, not a schema: the agent already told the machine a check failed, so the move is simply
          // not offered rather than asked for and refused.
          guard: checksPassed,
          schema: z.object({
            reviewed: z.array(z.string().min(1)).min(1).describe('what you reviewed, which is the record that you did'),
          }),
          actions: assign({ reviewed: ({ event }) => event.reviewed }),
        },
      },
    },

    // Each ending names itself on entry, so a door carries only what its event brought: `blocked` has three doors,
    // and an `outcome` assigned at each was the same fact written three times.
    //
    // The four endings that reached the pull request each name the act that closes it out. The machine has no
    // network, so it cannot do these and cannot check they were done (ADR-0009); what it can do is be the last thing
    // the agent reads, and say the whole of it. `unreachable` names no act because there is nothing to act on. Every
    // ending that could have changed something says so, through `leaveReview`, because a comment describing changes
    // nobody can see is worse than none.
    clean: {
      type: 'final',
      description: 'The pull request needs no changes.',
      entry: assign({ outcome: () => 'clean' as const }),
      instructions:
        'Approve the pull request. Say what you reviewed, which checks ran green or that it has none, and why it ' +
        'needs no changes, in the words you gave here.',
    },

    exhausted: {
      type: 'final',
      description: 'The rounds are used up with concerns outstanding.',
      entry: assign({ outcome: () => 'exhausted' as const }),
      // The ending most likely to be misread, so it says what silence would be read as.
      instructions:
        leaveReview('what you reviewed and every concern still open.') +
        ' Say plainly that the review ended at its round limit rather than because the work was done, so nobody ' +
        'reads silence as approval. Do not approve it.',
    },

    blocked: {
      type: 'final',
      description: 'The review cannot go further from here.',
      entry: assign({ outcome: () => 'blocked' as const }),
      // "What you looked at", not "what you reviewed": from `triaging` or `building` no review round happened.
      instructions:
        leaveReview('what you looked at, every concern still open, what stopped you from fixing them, and who could remove that.') +
        ' Say plainly that the review stopped because it was blocked rather than because the work was done, so ' +
        'nobody reads silence as approval. Do not approve it.',
    },

    unreachable: {
      type: 'final',
      description: 'The pull request could not be opened.',
      entry: assign({ outcome: () => 'unreachable' as const }),
      instructions: 'Nothing is left to do. The run ends here, and its output carries the reason you gave.',
    },

    complete: {
      type: 'final',
      description: 'The review is finished.',
      // Closing clears the concerns: `output` carries `concerns` as what is still open, and a round that closes has
      // answered the last round's. Left in place they would read as a close taken over them.
      entry: assign({ outcome: () => 'complete' as const, concerns: () => [] }),
      // Comment, do not approve: this agent wrote the changes, and approving your own work is not a review.
      instructions:
        leaveReview('what you reviewed and that every check the last round ran is green.') +
        ' Leave the approval to someone who did not write the changes.',
    },
  },
})
