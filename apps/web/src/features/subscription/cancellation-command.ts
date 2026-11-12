import { authenticationEndedEvent } from "@/session/authentication-channel";
import { Effect, Option } from "effect";
import { type AsyncResult, Atom } from "effect/reactivity";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";
import type { CanonicalSuccess, FidyClient, SubscriptionStatus } from "@/transport/client";

export type Cancellation = CanonicalSuccess<"subscription.cancelSubscription">["data"];
type CancellationFailure = Effect.Error<
  ReturnType<Effect.Success<FidyClient>["subscription"]["cancelSubscription"]>
>;
type StatusFailure = Effect.Error<
  ReturnType<Effect.Success<FidyClient>["subscription"]["getSubscriptionStatus"]>
>;
export const subscriptionStatusQuery: (
  client: FidyClient
) => Atom.Atom<
  AsyncResult.AsyncResult<CanonicalSuccess<"subscription.getSubscriptionStatus">, StatusFailure>
> = Atom.family((client: FidyClient) =>
  client.query("subscription", "getSubscriptionStatus", { timeToLive: "0 seconds" })
);

type Observation = AsyncResult.AsyncResult<
  CanonicalSuccess<"subscription.getSubscriptionStatus">,
  StatusFailure
>;
type Paid = Option.Option.Value<SubscriptionStatus["paidSubscription"]>;
type Phase =
  | Readonly<{ _tag: "Ready" | "Confirmed" | "Unknown" | "Cancelling" | "Disposed" }>
  | Readonly<{ _tag: "Reviewing"; paid: Paid; observation: Observation }>
  | Readonly<{ _tag: "Refreshing"; uncertain: boolean }>;
export type CancellationManagement = Readonly<{
  cancellation: Option.Option<Cancellation>;
  paid: SubscriptionStatus["paidSubscription"];
  reviewing: boolean;
  unavailable: boolean;
  loading: boolean;
  uncertain: boolean;
  busy: boolean;
  interacted: boolean;
  restoreFocus: boolean;
  review: () => void;
  back: () => void;
  confirm: () => void;
  refresh: () => void;
  mount: () => () => void;
}>;
type Owner = {
  client: FidyClient;
  get: Atom.AtomContext;
  phase: Phase;
  evidence: Option.Option<Cancellation>;
  active: boolean;
  generation: number;
  interacted: boolean;
  restoreFocus: boolean;
  command: Atom.AtomResultFn<Effect.Effect<void>, void, never>;
  mount: () => () => void;
};
const notify = (owner: Owner): void => owner.get.setSelf(present(owner));
const dispose = (owner: Owner): void => {
  owner.active = false;
  owner.generation += 1;
  if (owner.phase._tag === "Cancelling" || owner.phase._tag === "Refreshing") {
    owner.phase = { _tag: "Unknown" };
  } else if (owner.phase._tag === "Reviewing") {
    owner.phase = { _tag: "Ready" };
  }
  owner.get.set(owner.command, Atom.Interrupt);
};
const mount = (owner: Owner): (() => void) => {
  owner.active = true;
  notify(owner);
  const retire = (): void => {
    dispose(owner);
    owner.phase = { _tag: "Disposed" };
    notify(owner);
  };
  globalThis.addEventListener(authenticationEndedEvent, retire);
  globalThis.addEventListener("pagehide", retire);
  return () => {
    globalThis.removeEventListener(authenticationEndedEvent, retire);
    globalThis.removeEventListener("pagehide", retire);
    dispose(owner);
  };
};
const observe = (
  owner: Owner
): CanonicalQueryState<CanonicalSuccess<"subscription.getSubscriptionStatus">, StatusFailure> =>
  presentCanonicalQuery(owner.get.once(subscriptionStatusQuery(owner.client)));
const fresh = (owner: Owner): Option.Option<SubscriptionStatus> => {
  const status = observe(owner);
  return status._tag === "Ready" && !status.waiting && Option.isNone(status.refreshFailure)
    ? Option.some(status.value.data)
    : Option.none();
};
const execute = (
  owner: Owner,
  phase: Phase,
  work: Effect.Effect<Option.Option<Cancellation>, CancellationFailure | StatusFailure>
): void => {
  owner.phase = phase;
  owner.interacted = true;
  owner.restoreFocus = false;
  const generation = owner.generation;
  notify(owner);
  owner.get.set(
    owner.command,
    work.pipe(
      Effect.exit,
      Effect.flatMap((outcome) =>
        Effect.sync(() => {
          if (!current(owner, { generation, phase })) return;
          if (outcome._tag === "Failure") {
            owner.phase = { _tag: "Unknown" };
          } else {
            owner.evidence = Option.orElse(outcome.value, () => owner.evidence);
            owner.phase = { _tag: Option.isSome(owner.evidence) ? "Confirmed" : "Ready" };
          }
          notify(owner);
          if (outcome._tag === "Success" && phase._tag === "Cancelling" && owner.active) {
            owner.get.refresh(subscriptionStatusQuery(owner.client));
          }
        })
      )
    )
  );
};
type Snapshot = Readonly<{
  phase: Phase;
  generation: number;
}>;
const current = (owner: Owner, snapshot: Snapshot): boolean =>
  owner.active && owner.generation === snapshot.generation && owner.phase === snapshot.phase;
const review = (owner: Owner, snapshot: Snapshot): void => {
  const status = fresh(owner);
  if (!current(owner, snapshot) || snapshot.phase._tag !== "Ready" || Option.isNone(status)) {
    return;
  }
  const paid = status.value.paidSubscription;
  if (
    Option.isSome(owner.evidence) ||
    Option.isSome(status.value.cancellation) ||
    Option.isNone(paid)
  ) {
    return;
  }
  owner.phase = {
    _tag: "Reviewing",
    paid: paid.value,
    observation: owner.get.once(subscriptionStatusQuery(owner.client)),
  };
  owner.restoreFocus = false;
  notify(owner);
};
const confirm = (owner: Owner, snapshot: Snapshot): void => {
  const phase = snapshot.phase;
  if (
    !current(owner, snapshot) ||
    phase._tag !== "Reviewing" ||
    Option.isNone(fresh(owner)) ||
    phase.observation !== owner.get.once(subscriptionStatusQuery(owner.client))
  ) {
    return;
  }
  execute(
    owner,
    { _tag: "Cancelling" },
    owner.client.pipe(
      Effect.flatMap((api) => api.subscription.cancelSubscription({})),
      Effect.map((response) => Option.some(response.data))
    )
  );
};
const actions = (
  owner: Owner,
  snapshot: Snapshot
): Pick<CancellationManagement, "review" | "back" | "confirm" | "refresh" | "mount"> => ({
  review: () => review(owner, snapshot),
  back: () => {
    if (!current(owner, snapshot) || snapshot.phase._tag !== "Reviewing") {
      return;
    }
    owner.phase = { _tag: "Ready" };
    owner.restoreFocus = true;
    notify(owner);
  },
  confirm: () => confirm(owner, snapshot),
  refresh: () => {
    if (
      !current(owner, snapshot) ||
      snapshot.phase._tag === "Disposed" ||
      snapshot.phase._tag === "Cancelling" ||
      snapshot.phase._tag === "Refreshing"
    ) {
      return;
    }
    const query = subscriptionStatusQuery(owner.client);
    execute(
      owner,
      { _tag: "Refreshing", uncertain: snapshot.phase._tag === "Unknown" },
      Effect.sync(() => owner.get.refresh(query)).pipe(
        Effect.andThen(owner.get.resultOnce(query, { suspendOnWaiting: true })),
        Effect.map((response) => response.data.cancellation)
      )
    );
  },
  mount: owner.mount,
});
const unavailable = (status: ReturnType<typeof observe>): boolean =>
  status._tag === "Failure" || (status._tag === "Ready" && Option.isSome(status.refreshFailure));
const present = (owner: Owner): CancellationManagement => {
  const phase = owner.phase;
  const observation = owner.get.once(subscriptionStatusQuery(owner.client));
  const status = presentCanonicalQuery(observation);
  const standing =
    status._tag === "Ready" ? Option.some(status.value.data) : Option.none<SubscriptionStatus>();
  const cancellation = Option.orElse(owner.evidence, () =>
    Option.flatMap(standing, (value) => value.cancellation)
  );
  return {
    cancellation,
    paid:
      phase._tag === "Reviewing"
        ? Option.some(phase.paid)
        : Option.flatMap(standing, (value) => value.paidSubscription),
    reviewing: phase._tag === "Reviewing",
    unavailable: unavailable(status),
    loading: status._tag === "Initial",
    uncertain: phase._tag === "Unknown" || (phase._tag === "Refreshing" && phase.uncertain),
    busy: phase._tag === "Cancelling" || phase._tag === "Refreshing" || status.waiting,
    interacted: owner.interacted,
    restoreFocus: owner.restoreFocus,
    ...actions(owner, { phase, generation: owner.generation }),
  };
};
export const makeCancellationManagement = (client: FidyClient): Atom.Atom<CancellationManagement> =>
  Atom.make((get) => {
    const command = client.runtime.fn<Effect.Effect<void>>()((work) => work);
    const owner: Owner = {
      client,
      get,
      phase: { _tag: "Ready" },
      evidence: Option.none(),
      active: false,
      generation: 0,
      interacted: false,
      restoreFocus: false,
      command,
      mount: () => mount(owner),
    };
    get.mount(command);
    get.mount(subscriptionStatusQuery(client));
    get.subscribe(subscriptionStatusQuery(client), () => notify(owner));
    get.addFinalizer(() => dispose(owner));
    return present(owner);
  });
