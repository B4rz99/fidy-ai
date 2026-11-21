import { CanonicalAdmissionUnavailable } from "../canonical-admission/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { SqlClient } from "effect/sql";

import { getSubscriptionStatus } from "../../src/shell/subscription/operations";
import { canonicalAdmissionUnavailable, runLocalMutation } from "../canonical-admission/operations";

import { withStoreCapacity } from "../runtime/sqlite/operations";
import type { LocalMutationResult } from "../canonical-admission/contract";
import {
  cancellationReview,
  dispatchCancellations as dispatchLocalCancellations,
  repairCancellationAlarm as inspectCancellation,
  retainCancellation,
} from "./internal/local-cancellation";
import {
  SubscriptionCancellation,
  SubscriptionOffers,
  SubscriptionStatus,
} from "../../src/core/subscription/contract";
import { pricingName, refundSupportBasePath, refundSupportReadPath } from "./contract";
import { Effect, Option, Schema } from "effect";

export const refundSupportRoute = (path: string): boolean =>
  path === refundSupportBasePath || refundSupportReadPath.test(path);

export const retainSubscriptionCancellation: typeof retainCancellation = (input) =>
  retainCancellation(input);

export const offerDueSourceCancellations: typeof dispatchLocalCancellations = (input) =>
  dispatchLocalCancellations(input);

export const cancelLocalSubscription = Effect.fnUntraced(function* (
  input: Parameters<typeof retainCancellation>[0]
) {
  const result = yield* retainCancellation(input);

  if (Option.isNone(result)) {
    const absent: LocalMutationResult = {
      status: 404,
      outcome: "not_found",
      body: {
        error: { code: "not_found", message: "No paid Subscription belongs to you." },
        next: [],
      },
    };

    return absent;
  }

  const data = yield* Schema.encodeEffect(SubscriptionCancellation)(result.value);

  const completed: LocalMutationResult = {
    status: 200,
    outcome: "success",
    body: { data, next: [] },
  };

  return completed;
});

export const repairCancellationAlarm = Effect.fnUntraced(function* (storage: DurableObjectStorage) {
  return yield* withStoreCapacity("required")(inspectCancellation(storage));
});

export const isLocalSubscriptionRead = (id: string): boolean =>
  [
    "subscription.listSubscriptionOffers",
    "subscription.getSubscriptionStatus",
    "subscription.getUpgradeUrl",
  ].includes(id);

export const readLocalSubscriptionOffers = Effect.fnUntraced(function* (
  pricing: Pick<DurableObjectNamespace, "getByName">
) {
  const response = yield* Effect.tryPromise(() =>
    pricing.getByName(pricingName).fetch("https://pricing.internal/offers")
  );

  if (!response.ok) {
    return yield* new CanonicalAdmissionUnavailable({ cause: "pricing_unavailable" });
  }

  return yield* Effect.tryPromise(() => response.json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SubscriptionOffers)),
    Effect.flatMap(Schema.encodeEffect(SubscriptionOffers))
  );
});

export const readLocalSubscriptionStatus = Effect.fn(function* (
  user: Parameters<typeof getSubscriptionStatus>[0]
) {
  const { data } = yield* getSubscriptionStatus(user).pipe(
    Effect.provideService(SqlClient.SqlClient, yield* SqliteClient)
  );

  return yield* Schema.encodeEffect(Schema.toCodecJson(SubscriptionStatus))(data);
});

export const subscriptionReadResult = (data: Schema.Json): LocalMutationResult => ({
  status: 200,
  outcome: "success",
  body: { data, next: [] },
});

type UpgradeLocation = Readonly<{ url: string }>;

export const upgradeLocation = (origin: string): UpgradeLocation => ({
  url: new URL("/upgrade", origin).href,
});

export const observeLocalSubscription = Effect.fn(
  function* (
    unit: Pick<
      Parameters<typeof runLocalMutation>[0],
      "owns" | "storage" | "request" | "operation"
    >,
    env: { PRICING: DurableObjectNamespace; BROWSER_ORIGIN: string }
  ) {
    const selection = unit.operation.id;

    const offers =
      selection === "subscription.listSubscriptionOffers"
        ? Option.some(yield* readLocalSubscriptionOffers(env.PRICING))
        : Option.none();

    return yield* runLocalMutation({
      ...unit,
      input: Effect.succeedSome(true),
      work: Effect.fn(function* (_, user) {
        if (Option.isSome(offers)) return subscriptionReadResult(offers.value);

        if (selection === "subscription.getUpgradeUrl") {
          return subscriptionReadResult(upgradeLocation(env.BROWSER_ORIGIN));
        }

        return subscriptionReadResult(yield* readLocalSubscriptionStatus(user));
      }),
    });
  },
  Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
);

export const localCancellationReview: typeof cancellationReview = (user) =>
  cancellationReview(user);
