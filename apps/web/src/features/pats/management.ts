import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause, Effect, Option } from "effect";
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

type Target = Readonly<{ _tag: "One"; pat: ActivePATMetadata }> | Readonly<{ _tag: "All" }>;
type Outcome =
  | Readonly<{ _tag: "One"; shortId: TokenShortId }>
  | Readonly<{ _tag: "All"; revokedCount: number }>
  | Readonly<{
      _tag: "Refused";
      reason: "Authority" | "Consent" | "NotFound" | "Limited" | "Input";
    }>
  | Readonly<{ _tag: "Observed"; target: Target; active: boolean }>;
export type PATManagementTask =
  | Readonly<{ _tag: "Ready"; outcome: Option.Option<Outcome> }>
  | Readonly<{ _tag: "Reviewing"; target: Target; outcome: Option.Option<Outcome> }>
  | Readonly<{ _tag: "Revoking"; target: Target }>
  | Readonly<{ _tag: "Uncertain"; target: Target }>
  | Readonly<{ _tag: "Refreshing"; target: Target }>;
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
type Refusal = Extract<Outcome, { _tag: "Refused" }>;
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
  return reason === "Uncertain" ? Option.none() : Option.some({ _tag: "Refused", reason });
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
          command.target._tag === "One"
            ? client.pats
                .revokePAT({ params: { shortId: command.target.pat.shortId } })
                .pipe(
                  Effect.map((result): Outcome => ({ _tag: "One", shortId: result.data.shortId }))
                )
            : client.pats.revokeAllPATs({}).pipe(
                Effect.map((result): Outcome => ({
                  _tag: "All",
                  revokedCount: result.data.revokedCount,
                }))
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
        if (result === before || result._tag === "Initial" || result.waiting) return;
        if (result._tag === "Success") resume(Effect.succeed(result.value));
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
const ready: PATManagementTask = { _tag: "Ready", outcome: Option.none() };
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
  return current._tag === "Ready" && !current.waiting && Option.isNone(current.refreshFailure);
};
const review = (binding: Binding, target: Target): void => {
  if (!live(binding) || !usable(binding) || binding.task._tag !== "Ready") return;
  binding.owner.change({ _tag: "Reviewing", target, outcome: binding.task.outcome });
};
const admission = (
  binding: Binding,
  tag: "Revoking" | "Refreshing",
  target: Target
): (() => boolean) => {
  const pending: PATManagementTask = { _tag: tag, target };
  const generation = binding.owner.lifetime.generation;
  binding.owner.change(pending);
  return (): boolean =>
    binding.owner.lifetime.active &&
    binding.owner.lifetime.generation === generation &&
    binding.owner.current === pending;
};
const confirm = (binding: Binding): void => {
  const { owner, task } = binding;
  if (!live(binding) || !usable(binding) || task._tag !== "Reviewing") return;
  const current = admission(binding, "Revoking", task.target);
  binding.revoke({
    target: task.target,
    completed: (outcome) => {
      if (current()) owner.change({ _tag: "Ready", outcome: Option.some(outcome) });
    },
    uncertain: () => {
      if (current()) owner.change({ _tag: "Uncertain", target: task.target });
    },
  });
};
const refresh = (binding: Binding): void => {
  const { owner, task } = binding;
  if (!live(binding) || task._tag === "Revoking" || task._tag === "Refreshing") return;
  if (task._tag !== "Uncertain") {
    binding.registry.refresh(binding.query);
    return;
  }
  const current = admission(binding, "Refreshing", task.target);
  binding.refresh({
    completed: (pats) => {
      if (!current()) return;
      const target = task.target;
      owner.change({
        _tag: "Ready",
        outcome: Option.some({
          _tag: "Observed",
          target,
          active: target._tag === "One" && pats.some((pat) => pat.shortId === target.pat.shortId),
        }),
      });
    },
    failed: () => {
      if (current()) owner.change({ _tag: "Uncertain", target: task.target });
    },
  });
};
const actions = (binding: Binding): PATManagementActions => ({
  reviewOne: (shortId) => {
    const current = presentCanonicalQuery(binding.registry.get(binding.query));
    if (current._tag !== "Ready") return;
    const pat = current.value.data.pats.find((candidate) => candidate.shortId === shortId);
    if (pat !== undefined) review(binding, { _tag: "One", pat });
  },
  reviewAll: () => review(binding, { _tag: "All" }),
  cancel: () => {
    if (live(binding) && binding.task._tag === "Reviewing") {
      binding.owner.change({ _tag: "Ready", outcome: binding.task.outcome });
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

/** One mounted review owns single/all admission; metadata recovery cannot reconstruct a lost receipt. */
export const usePATManagement = (
  apiClient: FidyClient
): Readonly<{
  query: CanonicalQueryState<ListValue, ListFailure>;
  task: PATManagementTask;
  actions: PATManagementActions;
  lifecycleRef: RefCallback<HTMLElement>;
}> => {
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
