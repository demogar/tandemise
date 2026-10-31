/**
 * The shipped `routing.yaml` (#53 §6.1). No ladders: every step keeps its
 * role's model until the owner writes one. The numbers apply once they do.
 *
 * - `target` 0.8: a model is chosen when the lower bound of its first-attempt
 *   success rate is at least 80%; below that a person would be stepping in on
 *   one task in five.
 * - `minSamples` 8: under eight measured tasks a Wilson bound is too wide to
 *   say anything, so the class's `default` applies.
 * - `probeEvery` 10: one low-risk task in ten tries a cheaper rung, so a
 *   cheaper model that has improved gets measured again.
 */
export const SHIPPED_ROUTING = { version: 1, target: 0.8, minSamples: 8, probeEvery: 10, classes: {} } as const;
