import { Effect, Option } from "effect";
import { type AsyncResult, Atom } from "effect/reactivity";
import type { CanonicalSuccess, FidyClient } from "@/transport/client";

export type Cancellation = CanonicalSuccess<"subscription.cancelSubscription">["data"];
type CancellationClient = Effect.Success<FidyClient>;
type CancellationFailure = Effect.Error<
  ReturnType<CancellationClient["subscription"]["cancelSubscription"]>
>;
type StatusFailure = Effect.Error<
  ReturnType<CancellationClient["subscription"]["getSubscriptionStatus"]>
>;
export const subscriptionStatusQuery: (
  client: FidyClient
) => Atom.Atom<
  AsyncResult.AsyncResult<CanonicalSuccess<"subscription.getSubscriptionStatus">, StatusFailure>
> = Atom.family((client: FidyClient) =>
  client.query("subscription", "getSubscriptionStatus", { timeToLive: "0 seconds" })
);

export const makeCancellationCommand = (
  client: FidyClient
): Atom.AtomResultFn<"cancel" | "refresh", Option.Option<Cancellation>, CancellationFailure> =>
  client.runtime.fn<"cancel" | "refresh">()((action, get) => {
    const query = client.pipe(subscriptionStatusQuery);
    if (action === "refresh") {
      get.refresh(query);
      return get
        .result(query, { suspendOnWaiting: true })
        .pipe(Effect.as(Option.none<Cancellation>()));
    }
    return client.pipe(
      Effect.flatMap((api) => api.subscription.cancelSubscription({})),
      Effect.tap(() => Effect.sync(() => get.refresh(query))),
      Effect.map((response) => Option.some(response.data))
    );
  });
