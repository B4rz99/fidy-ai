import { authenticationEndedEvent } from "@/session/authentication-channel";
import { Data, Effect, Option, Predicate } from "effect";
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

type Phase = Data.TaggedEnum<{
  Ready: {};
  Confirmed: {};
  Unknown: {};
  Disposed: {};
  Reviewing: Readonly<{ paid: Paid; observation: Observation }>;
  Cancelling: Readonly<{ paid: Paid }>;
  Refreshing: Readonly<{ uncertain: boolean }>;
}>;

const Phase = Data.taggedEnum<Phase>();

export type CancellationManagement = Readonly<{
  cancellation: Option.Option<Cancellation>;
  paid: SubscriptionStatus["paidSubscription"];
  reviewing: boolean;
  cancelling: boolean;
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

  if (
    Predicate.isTagged(owner.phase, "Cancelling") ||
    Predicate.isTagged(owner.phase, "Refreshing")
  ) {
    owner.phase = Phase.Unknown();
  } else if (Predicate.isTagged(owner.phase, "Reviewing")) {
    owner.phase = Phase.Ready();
  }

  owner.get.set(owner.command, Atom.Interrupt);
};

const mount = (owner: Owner): (() => void) => {
  owner.active = true;
  notify(owner);

  const retire = (): void => {
    dispose(owner);
    owner.phase = Phase.Disposed();
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

  return Predicate.isTagged(status, "Ready") &&
    !status.waiting &&
    Option.isNone(status.refreshFailure)
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

          if (Predicate.isTagged(outcome, "Failure")) {
            owner.phase = Phase.Unknown();
          } else {
            owner.evidence = Option.orElse(outcome.value, () => owner.evidence);
            owner.phase = Option.isSome(owner.evidence) ? Phase.Confirmed() : Phase.Ready();
          }

          notify(owner);

          if (
            Predicate.isTagged(outcome, "Success") &&
            Predicate.isTagged(phase, "Cancelling") &&
            owner.active
          ) {
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

  if (
    !current(owner, snapshot) ||
    !Predicate.isTagged(snapshot.phase, "Ready") ||
    Option.isNone(status)
  ) {
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

  owner.phase = Phase.Reviewing({
    paid: paid.value,
    observation: owner.get.once(subscriptionStatusQuery(owner.client)),
  });
  owner.restoreFocus = false;
  notify(owner);
};

const confirm = (owner: Owner, snapshot: Snapshot): void => {
  const phase = snapshot.phase;

  if (
    !current(owner, snapshot) ||
    !Predicate.isTagged(phase, "Reviewing") ||
    Option.isNone(fresh(owner)) ||
    phase.observation !== owner.get.once(subscriptionStatusQuery(owner.client))
  ) {
    return;
  }

  execute(
    owner,
    Phase.Cancelling({ paid: phase.paid }),
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
    if (!current(owner, snapshot) || !Predicate.isTagged(snapshot.phase, "Reviewing")) {
      return;
    }

    owner.phase = Phase.Ready();
    owner.restoreFocus = true;
    notify(owner);
  },
  confirm: () => confirm(owner, snapshot),
  refresh: () => {
    if (
      !current(owner, snapshot) ||
      Predicate.isTagged(snapshot.phase, "Disposed") ||
      Predicate.isTagged(snapshot.phase, "Cancelling") ||
      Predicate.isTagged(snapshot.phase, "Refreshing")
    ) {
      return;
    }

    const query = subscriptionStatusQuery(owner.client);
    execute(
      owner,
      Phase.Refreshing({ uncertain: Predicate.isTagged(snapshot.phase, "Unknown") }),
      Effect.sync(() => owner.get.refresh(query)).pipe(
        Effect.andThen(owner.get.resultOnce(query, { suspendOnWaiting: true })),
        Effect.map((response) => response.data.cancellation)
      )
    );
  },
  mount: owner.mount,
});

const unavailable = (status: ReturnType<typeof observe>): boolean =>
  Predicate.isTagged(status, "Failure") ||
  (Predicate.isTagged(status, "Ready") && Option.isSome(status.refreshFailure));

const reviewed = (
  phase: Phase
): phase is Data.TaggedEnum.Value<Phase, "Reviewing" | "Cancelling"> =>
  Predicate.isTagged(phase, "Reviewing") || Predicate.isTagged(phase, "Cancelling");

const present = (owner: Owner): CancellationManagement => {
  const phase = owner.phase;
  const observation = owner.get.once(subscriptionStatusQuery(owner.client));
  const status = presentCanonicalQuery(observation);

  const standing = Predicate.isTagged(status, "Ready")
    ? Option.some(status.value.data)
    : Option.none<SubscriptionStatus>();

  const cancellation = Option.orElse(owner.evidence, () =>
    Option.flatMap(standing, (value) => value.cancellation)
  );

  return {
    cancellation,
    paid: reviewed(phase)
      ? Option.some(phase.paid)
      : Option.flatMap(standing, (value) => value.paidSubscription),
    reviewing: reviewed(phase),
    cancelling: Predicate.isTagged(phase, "Cancelling"),
    unavailable: unavailable(status),
    loading: Predicate.isTagged(status, "Initial"),
    uncertain:
      Predicate.isTagged(phase, "Unknown") ||
      (Predicate.isTagged(phase, "Refreshing") && phase.uncertain),
    busy:
      Predicate.isTagged(phase, "Cancelling") ||
      Predicate.isTagged(phase, "Refreshing") ||
      status.waiting,
    interacted: owner.interacted,
    restoreFocus: owner.restoreFocus,
    ...actions(owner, { phase, generation: owner.generation }),
  };
};

export const cancellationManagementAtom = (client: FidyClient): Atom.Atom<CancellationManagement> =>
  Atom.make((get) => {
    const command = client.runtime.fn<Effect.Effect<void>>()((work) => work);

    const owner: Owner = {
      client,
      get,
      phase: Phase.Ready(),
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
    get.subscribe(subscriptionStatusQuery(client), (observation) => {
      if (Predicate.isTagged(owner.phase, "Reviewing") && owner.phase.observation !== observation) {
        owner.phase = Phase.Ready();
        owner.restoreFocus = true;
      }

      notify(owner);
    });
    get.addFinalizer(() => dispose(owner));

    return present(owner);
  });
