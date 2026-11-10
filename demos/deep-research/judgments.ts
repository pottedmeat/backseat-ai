import { noul, score, TypeSafeClient, type NoulResponse, type Question, type ResultFor } from '@typesafe-ai/sdk'

// ---- the lead's budget and each round's pick, judged by TypeSafe rather than by the lead ---------------------------

/**
 * The key is read from `TYPESAFE_API_KEY`, and this demo's `.env` is loaded for it when there is one. The client is made
 * per call, not at import: the SDK throws on a missing key, and registering the machine must not need one.
 */
try {
  process.loadEnvFile(new URL('.env', import.meta.url))
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}

/** How many research rounds the question warrants. Ten levels, lowest first: index 0 is one round. */
const ROUND_LEVELS = [
  'A single fact with one authoritative source: one pass of searching settles it.',
  'A narrow factual question whose answer may need a second source to confirm.',
  'A focused question with a short list of candidates or sources to find and then check.',
  'A question that needs its candidates found first and then each examined in turn.',
  'A comparison across several options or sources, where a first pass surfaces what a second must verify.',
  'A multi-part question whose parts each need their own search and a follow-up.',
  'A broad question across several domains, where early findings redirect later research.',
  'A contested or fast-moving topic where sources disagree and each claim needs tracing to its origin.',
  'A survey of a whole field, needing repeated passes to map it, then fill and verify its gaps.',
  'An open-ended investigation with no settled answer, needing many rounds of widening and deepening.',
] as const

/** Why the budget is that many rounds, one sentence per level of `ROUND_LEVELS`, shown to the lead once on arrival. */
const ROUND_BUDGETS = [
  'One round at most: a single fact with one authoritative source is settled in one pass of searching.',
  'Two rounds at most: a narrow factual answer may need a second source to confirm it.',
  'Three rounds at most: a short list of candidates or sources has to be found, then each checked.',
  'Four rounds at most: the candidates have to be found first, then each examined in turn.',
  'Five rounds at most: several options or sources are compared, and what a first pass surfaces a second has to verify.',
  'Six rounds at most: each part of the question needs its own search and a follow-up.',
  'Seven rounds at most: the question spans several domains, and early findings redirect the later research.',
  'Eight rounds at most: the sources disagree, and each claim has to be traced to its origin.',
  'Nine rounds at most: a whole field has to be mapped in repeated passes, then its gaps filled and verified.',
  'Ten rounds at most: there is no settled answer, and the investigation widens and deepens over many rounds.',
] as const

/** How many of a round's proposed searches to run. Ten levels, lowest first: index 0 is one search. */
const SEARCH_LEVELS = [
  'One search: a single gap is left, and one lookup closes it.',
  'Two searches: the round has one gap with two sides, or two small gaps.',
  'Three searches: a few specific claims or candidates need checking at their source.',
  'Four searches: a handful of distinct gaps, each needing its own search.',
  'Five searches: several angles, none of which the others would cover.',
  'Six searches: a broad round where many candidates or sources are still unexamined.',
  'Seven searches: a wide round mapping most of a topic’s distinct angles.',
  'Eight searches: nearly every proposed angle is distinct and would add something.',
  'Nine searches: a sweeping round where almost all of the proposals are needed.',
  'Ten searches: the question is wide open and every distinct angle proposed is worth running.',
] as const

/** A Score's expected level, rounded to the nearest one and counted from 1. */
const asCount = (expected: number) => Math.round(expected) + 1

/** The maximum number of research rounds for `question`, from 1 to 10, and one sentence on what they are for. */
export const judgeMaxRounds = async (question: string): Promise<{ rounds: number; budget: string }> => {
  const res = await new TypeSafeClient().systemOne({
    state: { question },
    questions: {
      rounds: score(
        'How much research does `question` need? A round is one pass of parallel web searches followed by a ' +
          'review of what they found; judge how many such rounds a thorough answer would take.',
        ROUND_LEVELS,
      ),
    },
  })
  const rounds = asCount(res.answers.rounds.score)
  return { rounds, budget: ROUND_BUDGETS[rounds - 1]! }
}

/** How many of the most relevant proposals are checked against each other for overlap. 15 makes 105 pairs. */
const SHORTLIST = 15
/** Above this, two searches are taken to turn up the same thing. A starting guess, to be tuned on real rounds. */
const OVERLAP = 0.7

/**
 * The proposals to run this round, best first, no two of them alike. Two requests:
 *
 * 1. Each proposal is judged on its own for relevance to the question, and TypeSafe judges how many searches the round
 *    should run (1 to 10). The most relevant `SHORTLIST` go on.
 * 2. Each pair on the shortlist is judged for overlap: would the two turn up the same sources and facts. Each pair is
 *    asked one way only, since the model need not answer (a, b) and (b, a) alike.
 *
 * Code joins overlapping pairs into groups and runs the most relevant proposal of each group, up to the count. Fewer
 * groups than the count means fewer searches: the rest would have repeated one already run.
 */
export const pickSearches = async (question: string, round: number, proposals: string[]): Promise<string[]> => {
  const client = new TypeSafeClient()
  const ids = proposals.map((_, i) => `s${i + 1}`)
  const texts = Object.fromEntries(ids.map((id, i) => [id, proposals[i]!]))

  const relevance: Record<string, Question> = {}
  for (const id of ids)
    relevance[id] = noul(`Would running the web search \`proposals.${id}\` find information that directly moves ` +
      '`question` forward?', {
      true: 'It targets a fact, entity or claim that answering `question` depends on.',
      false: 'It is only on the general topic of `question`, and what it finds would not change the answer.',
    })
  const first = await client.systemOne({
    state: { question, round, proposals: texts },
    questions: {
      count: score(
        '`question` is being researched in rounds of parallel web searches, and this is round `round`. How many ' +
          'searches should this round run?',
        SEARCH_LEVELS,
      ),
      ...relevance,
    },
  })
  const answers = first.answers as Record<string, ResultFor<Question>>
  const relevanceOf = (id: string) => (answers[id] as NoulResponse).noul
  const count = asCount(first.answers.count.score)
  const shortlist = [...ids].sort((a, b) => relevanceOf(b) - relevanceOf(a)).slice(0, SHORTLIST)

  const pairs = shortlist.flatMap((a, i) => shortlist.slice(i + 1).map((b): [string, string] => [a, b]))
  const overlap: Record<string, Question> = {}
  for (const [a, b] of pairs)
    overlap[`${a}-${b}`] = noul(`Would running the web searches \`proposals.${a}\` and \`proposals.${b}\` mostly ` +
      'turn up the same sources and facts?', {
      true: 'Both target the same specific fact, entity or claim, so the second adds little the first did not find.',
      false: 'They share a topic but target a different fact, entity, period or angle, so each finds something new.',
    })
  const second = await client.systemOne({
    state: { proposals: Object.fromEntries(shortlist.map((id) => [id, texts[id]!])) },
    questions: overlap,
  })

  // Each proposal's group, named by the most relevant proposal in it: merging two groups keeps the higher-ranked name.
  const group = new Map(shortlist.map((id) => [id, id]))
  const root = (id: string): string => (group.get(id) === id ? id : root(group.get(id)!))
  for (const [a, b] of pairs)
    if ((second.answers[`${a}-${b}`] as NoulResponse).noul > OVERLAP) {
      const [ra, rb] = [root(a), root(b)].sort((x, y) => shortlist.indexOf(x) - shortlist.indexOf(y)) as [string, string]
      group.set(rb, ra)
    }
  return shortlist.filter((id) => root(id) === id).slice(0, count).map((id) => texts[id]!)
}
