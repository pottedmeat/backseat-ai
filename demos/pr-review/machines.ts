import { prReview } from './pr-review.ts'

/**
 * The catalog: what an agent may create, under the name it creates it by. One machine, one entry — this demo spawns
 * nothing, so there is no spawn-only machine to keep out.
 */
export default { 'pr-review': prReview }
