import type { UserId } from "../../src/core/identity/contract";
import {
  discoverDueInsights as discover,
  findInsight as find,
  findInsightAttempt as findAttempt,
  generateInsight as generate,
  listPendingInsights as list,
  prepareInsightTransition as prepare,
  insightRefusal as refuse,
} from "./internal/insight-store";

/**
 * Read one User's authoritative occurrence inside that User's coordination boundary. The caller
 * establishes the purpose and live authority; an occurrence identity grants no access by itself.
 * Retained schedule context and exact Currency-separated Money never follow later preferences.
 */
export const findInsight = (
  input: Omit<Parameters<typeof find>[0], "userId"> & Readonly<{ userId: UserId }>
): ReturnType<typeof find> => find(input);

/**
 * Retain one scheduled occurrence for an explicit User under the existing User coordinator.
 * Supply validated historical schedule context and Money groups from published owner projections,
 * never another owner's rows. Replay returns the original occurrence without rewriting its facts
 * or lifecycle. The caller establishes current processing authority before generation.
 */
export const generateInsight = (
  input: Omit<Parameters<typeof generate>[0], "userId"> & Readonly<{ userId: UserId }>
): ReturnType<typeof generate> => generate(input);

/**
 * Discover at most 64 pending due identities, oldest scheduled instant then identity first.
 * These are coordination hints only: enter each User's existing coordinator, recheck current
 * authority and read its authoritative occurrence before processing or delivery.
 */
export const discoverDueInsights: typeof discover = (input) => discover(input);

/**
 * Read one bounded canonical pending page under the caller's live credential and explicit User.
 * Cursor ordering and canonical delivery share the same authoritative occurrence records.
 */
export const listPendingInsights: typeof list = (input) => list(input);

/**
 * Prepare one forward-only lifecycle movement, actual send evidence and metadata-only Audit for
 * the shared one-User canonical commit. The caller owns the atomic unit and coordination; live
 * credential, Consent and current lifecycle are rechecked at commit, so stale work cannot regress.
 * Preparing or recording delivery does not send anything to an external provider.
 */
export const prepareInsightTransition: typeof prepare = (input) => prepare(input);

/** Present and record a closed lifecycle refusal under the same live caller's authority. */
export const insightRefusal: typeof refuse = (input) => refuse(input);

/** Read the same User's immutable send evidence without treating provider identity as authority. */
export const findInsightAttempt = (
  input: Omit<Parameters<typeof findAttempt>[0], "userId"> & Readonly<{ userId: UserId }>
): ReturnType<typeof findAttempt> => findAttempt(input);
