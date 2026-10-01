import { Option } from "effect";

/**
 * The commit-time D1 trigger names one refused canonical unit can carry. D1 exposes a trigger only
 * through its error message, so these names are the decoded contract; the `RAISE(ABORT, …)`
 * triggers in the D1 migrations remain the authority that admitted or refused the work, and each
 * name here must be spelled exactly as its migration spells it.
 */
export const canonicalTriggerNames = {
  resourceLimit: "transaction_resource_limit",
  keywordRuleLimit: "keyword_rule_limit",
  memoryCapacity: "memory_capacity_exceeded",
} as const;

/** One commit-time trigger name a D1 failure message can carry. */
export type CanonicalTriggerName =
  (typeof canonicalTriggerNames)[keyof typeof canonicalTriggerNames];

/** The commit-time trigger one D1 failure names, or None when no known trigger refused it. */
export const canonicalTriggerOf = (cause: unknown): Option.Option<CanonicalTriggerName> =>
  Option.fromUndefinedOr(
    Object.values(canonicalTriggerNames).find((name) => String(cause).includes(name))
  );
