import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause, Data, Effect, Option, Predicate } from "effect";
import { type AsyncResult, Atom, type AtomRegistry, Reactivity } from "effect/reactivity";
import { type RefCallback, useCallback, useContext, useState } from "react";
import { authenticationEndedEvent } from "@/session/authentication-events";
import {
  type ActivePATMetadata,
  type CanonicalSuccess,
  type FidyClient,
  type TokenShortId,
} from "@/transport/client";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";
import { workspaceQueryRetention } from "@/transport/workspace-query";
import { activePATReactivityKey } from "./presentation";

type Target = Data.TaggedEnum<{
  One: { readonly pat: ActivePATMetadata };
  All: {};
}>;

const Target = Data.taggedEnum<Target>();

type Outcome = Data.TaggedEnum<{
  One: { readonly shortId: TokenShortId };
  All: { readonly revokedCount: number };
  Refused: { readonly reason: "Authority" | "Consent" | "NotFound" | "Limited" | "Input" };
  Observed: { readonly target: Target; readonly active: boolean };
}>;

const Outcome = Data.taggedEnum<Outcome>();

export type PATManagementTask = Data.TaggedEnum<{
  Ready: { readonly outcome: Option.Option<Outcome> };
  Reviewing: { readonly target: Target; readonly outcome: Option.Option<Outcome> };
  Revoking: { readonly target: Target };
  Uncertain: { readonly target: Target };
  Refreshing: { readonly target: Target };
}>;

const PATManagementTask = Data.taggedEnum<PATManagementTask>();

export type PATManagementActions = Readonly<{
  reviewOne: (shortId: TokenShortId) => void;
  reviewAll: () => void;
  cancel: () => void;
  confirm: () => void;
  refresh: () => void;
}>;

type ListValue = CanonicalSuccess<"pats.listPATs">;

type ListFailure = Effect.Error<ReturnType<Effect.Success<FidyClient>["pats"]["listPATs"]>>;

type ListQuery = Atom.Atom<AsyncResult.AsyncResult<ListValue, ListFailure>>;

const listingSource: (client: FidyClient) => ListQuery = Atom.family((apiClient: FidyClient) =>
  apiClient.query("pats", "listPATs", {
    ...workspaceQueryRetention,
    reactivityKeys: [activePATReactivityKey],
  })
);

const listing: (client: FidyClient) => ListQuery = Atom.family((apiClient: FidyClient) =>
  listingSource(apiClient).pipe(
    Atom.swr({
      staleTime: 0,
      revalidateOnMount: true,
      revalidateOnFocus: "always",
      focusSignal: Atom.windowFocusSignal,
    })
  )
);

type RevocationError = Effect.Error<ReturnType<Effect.Success<FidyClient>["pats"]["revokePAT"]>>;

type Refusal = Data.TaggedEnum.Value<Outcome, "Refused">;

const refusalReasons: Readonly<Record<RevocationError["_tag"], Refusal["reason"] | "Uncertain">> = {
  Unauthenticated: "Authority",
  ScopeMissing: "Authority",
  ConsentRequired: "Consent",
  UserActionRequired: "Consent",
  NotFound: "NotFound",
  ResourceLimited: "Limited",
  ValidationFailed: "Input",
  HttpClientError: "Uncertain",
  PaywallRequired: "Uncertain",
  QuotaExhausted: "Uncertain",
  SchemaError: "Uncertain",
  Unavailable: "Uncertain",
};

const refusal = (error: RevocationError): Option.Option<Refusal> => {
  const reason = refusalReasons[error._tag];

  return reason === "Uncertain" ? Option.none() : Option.some(Outcome.Refused({ reason }));
};

type Command = Readonly<{
  target: Target;
  completed: (outcome: Outcome) => void;
  uncertain: () => void;
}>;

const revokeCommand = (apiClient: FidyClient): Atom.AtomResultFn<Command, void, never> =>
  apiClient.runtime.fn<Command>()(
    (command) =>
      Effect.gen(function* () {
        const client = yield* apiClient;

        const outcome: Outcome = yield* Reactivity.mutation(
          Predicate.isTagged(command.target, "One")
            ? client.pats
                .revokePAT({ params: { shortId: command.target.pat.shortId } })
                .pipe(
                  Effect.map((result): Outcome => Outcome.One({ shortId: result.data.shortId }))
                )
            : client.pats
                .revokeAllPATs({})
                .pipe(
                  Effect.map((result): Outcome =>
                    Outcome.All({ revokedCount: result.data.revokedCount })
                  )
                ),
          [activePATReactivityKey]
        );

        yield* Effect.sync(() => command.completed(outcome));
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const declared =
              Cause.hasDies(cause) || Cause.hasInterrupts(cause)
                ? Option.none()
                : Cause.findErrorOption(cause).pipe(Option.flatMap(refusal));

            Option.match(declared, { onNone: command.uncertain, onSome: command.completed });
          })
        )
      ),
    { concurrent: false }
  );

type Recovery = Readonly<{
  completed: (pats: ReadonlyArray<ActivePATMetadata>) => void;
  failed: () => void;
}>;

const readFreshListing = (
  apiClient: FidyClient,
  get: Atom.FnContext
): Effect.Effect<ListValue, ListFailure> => {
  const query = listingSource(apiClient);
  const before = get.registry.get(query);

  return Effect.callback<ListValue, ListFailure>((resume) => {
    const unsubscribe = get.registry.subscribe(
      query,
      (result) => {
        if (result === before || Predicate.isTagged(result, "Initial") || result.waiting) return;

        if (Predicate.isTagged(result, "Success")) resume(Effect.succeed(result.value));
        else resume(Effect.failCause(result.cause));
      },
      { immediate: false }
    );

    get.refresh(query);

    return Effect.sync(unsubscribe);
  });
};

const refreshCommand = (apiClient: FidyClient): Atom.AtomResultFn<Recovery, void, never> =>
  apiClient.runtime.fn<Recovery>()(
    (command, get) =>
      Effect.gen(function* () {
        const fresh = yield* readFreshListing(apiClient, get);
        yield* Effect.sync(() => command.completed(fresh.data.pats));
      }).pipe(Effect.catchCause(() => Effect.sync(command.failed))),
    { concurrent: false }
  );

type Owner = {
  lifetime: { active: boolean; generation: number };
  current: PATManagementTask;
  change: (next: PATManagementTask) => void;
};

const ready: PATManagementTask = PATManagementTask.Ready({ outcome: Option.none() });

const makeOwner = (change: (next: PATManagementTask) => void): Owner => {
  const owner: Owner = {
    lifetime: { active: false, generation: 0 },
    current: ready,
    change: (next) => {
      owner.current = next;
      change(next);
    },
  };

  return owner;
};

type Binding = Readonly<{
  owner: Owner;
  task: PATManagementTask;
  registry: AtomRegistry.AtomRegistry;
  query: ReturnType<typeof listing>;
  observation: Atom.Type<ListQuery>;
  revoke: (command: Command) => void;
  refresh: (command: Recovery) => void;
}>;

const live = ({ owner, task }: Binding): boolean => owner.lifetime.active && owner.current === task;

const usable = ({ registry, query, observation }: Binding): boolean => {
  if (registry.get(query) !== observation) return false;
  const current = presentCanonicalQuery(registry.get(query));

  return (
    Predicate.isTagged(current, "Ready") &&
    !current.waiting &&
    Option.isNone(current.refreshFailure)
  );
};

const review = (binding: Binding, target: Target): void => {
  if (!live(binding) || !usable(binding) || !Predicate.isTagged(binding.task, "Ready")) return;
  binding.owner.change(PATManagementTask.Reviewing({ target, outcome: binding.task.outcome }));
};

const admission = (binding: Binding, pending: PATManagementTask): (() => boolean) => {
  const generation = binding.owner.lifetime.generation;
  binding.owner.change(pending);

  return (): boolean =>
    binding.owner.lifetime.active &&
    binding.owner.lifetime.generation === generation &&
    binding.owner.current === pending;
};

const confirm = (binding: Binding): void => {
  const { owner, task } = binding;

  if (!live(binding) || !usable(binding) || !Predicate.isTagged(task, "Reviewing")) return;
  const current = admission(binding, PATManagementTask.Revoking({ target: task.target }));
  binding.revoke({
    target: task.target,
    completed: (outcome) => {
      if (current()) owner.change(PATManagementTask.Ready({ outcome: Option.some(outcome) }));
    },
    uncertain: () => {
      if (current()) owner.change(PATManagementTask.Uncertain({ target: task.target }));
    },
  });
};

const refresh = (binding: Binding): void => {
  const { owner, task } = binding;

  if (
    !live(binding) ||
    Predicate.isTagged(task, "Revoking") ||
    Predicate.isTagged(task, "Refreshing")
  ) {
    return;
  }

  if (!Predicate.isTagged(task, "Uncertain")) {
    binding.registry.refresh(binding.query);

    return;
  }

  const current = admission(binding, PATManagementTask.Refreshing({ target: task.target }));
  binding.refresh({
    completed: (pats) => {
      if (!current()) return;
      const target = task.target;
      owner.change(
        PATManagementTask.Ready({
          outcome: Option.some(
            Outcome.Observed({
              target,
              active:
                Predicate.isTagged(target, "One") &&
                pats.some((pat) => pat.shortId === target.pat.shortId),
            })
          ),
        })
      );
    },
    failed: () => {
      if (current()) owner.change(PATManagementTask.Uncertain({ target: task.target }));
    },
  });
};

const actions = (binding: Binding): PATManagementActions => ({
  reviewOne: (shortId) => {
    const current = presentCanonicalQuery(binding.registry.get(binding.query));

    if (!Predicate.isTagged(current, "Ready")) return;
    const pat = current.value.data.pats.find((candidate) => candidate.shortId === shortId);

    if (pat !== undefined) review(binding, Target.One({ pat }));
  },
  reviewAll: () => review(binding, Target.All()),
  cancel: () => {
    if (live(binding) && Predicate.isTagged(binding.task, "Reviewing")) {
      binding.owner.change(PATManagementTask.Ready({ outcome: binding.task.outcome }));
    }
  },
  confirm: () => confirm(binding),
  refresh: () => refresh(binding),
});

const mount =
  (owner: Owner, stop: () => void): RefCallback<HTMLElement> =>
  (node) => {
    if (node === null) return;
    owner.lifetime.active = true;

    const dispose = (): void => {
      owner.lifetime.active = false;
      owner.lifetime.generation += 1;
      stop();
    };

    window.addEventListener(authenticationEndedEvent, dispose);

    return (): void => {
      dispose();
      window.removeEventListener(authenticationEndedEvent, dispose);
    };
  };

type PATManagementController = Readonly<{
  query: CanonicalQueryState<ListValue, ListFailure>;
  task: PATManagementTask;
  actions: PATManagementActions;
  lifecycleRef: RefCallback<HTMLElement>;
}>;

export const usePATManagement = (apiClient: FidyClient): PATManagementController => {
  const registry = useContext(RegistryContext);
  const [queryAtom] = useState(() => listing(apiClient));
  const observation = useAtomValue(queryAtom);
  const query = presentCanonicalQuery(observation);
  const [task, setTask] = useState<PATManagementTask>(ready);
  const [owner] = useState(() => makeOwner(setTask));
  const [revokeAtom] = useState(() => revokeCommand(apiClient));
  const [refreshAtom] = useState(() => refreshCommand(apiClient));
  const revoke = useAtomSet(revokeAtom);
  const reread = useAtomSet(refreshAtom);

  const lifecycleRef = useCallback<RefCallback<HTMLElement>>(
    (node) =>
      mount(owner, () => {
        registry.set(revokeAtom, Atom.Interrupt);
        registry.set(refreshAtom, Atom.Interrupt);
      })(node),
    [owner, registry, revokeAtom, refreshAtom]
  );

  return {
    query,
    task,
    lifecycleRef,
    actions: actions({
      owner,
      task,
      registry,
      query: listingSource(apiClient),
      observation,
      revoke,
      refresh: reread,
    }),
  };
};
