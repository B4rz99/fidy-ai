import { Cause, DateTime, Deferred, Effect, Option, Predicate } from "effect";
import { Atom } from "effect/reactivity";
import type { CanonicalInput, CanonicalSuccess, FidyClient } from "@/transport/client";
import { isCanonicalInput } from "@/transport/canonical-input";
import { reportBrowserDefect } from "@/transport/browser-defects";
import { parseMoneyInput } from "@/transport/money-input";
import type { CaptureDraft } from "./capture-draft";
import type { Category } from "./presentation";

type Created = CanonicalSuccess<"transactions.createTransaction">["data"];
type Submission = Readonly<{
  categories: ReadonlyArray<Category>;
  onCreated: (transaction: Created) => void;
  invalidate: () => void;
}>;
type Status = "editing" | "invalid" | "saving" | "saved" | "rejected" | "unknown";
export type TransactionCaptureTask = Readonly<{
  draft: CaptureDraft;
  timeZone: string;
  saving: boolean;
  uncertain: boolean;
  rejected: boolean;
  invalid: boolean;
  locked: boolean;
  created: Option.Option<Created>;
  attempt: Option.Option<CaptureDraft>;
  change: (draft: CaptureDraft) => void;
  submit: (submission: Submission) => void;
  restart: (input: Readonly<{ draft: CaptureDraft; timeZone: string }>) => void;
  resume: () => void;
  mount: () => () => void;
}>;
type Input = Readonly<{ client: FidyClient; initial: CaptureDraft; timeZone: string }>;
type Owner = Omit<Input, "initial" | "timeZone"> & {
  get: Atom.AtomContext;
  timeZone: string;
  status: Status;
  draft: CaptureDraft;
  created: Option.Option<Created>;
  attempt: Option.Option<CaptureDraft>;
  active: boolean;
  generation: number;
  stopped: Deferred.Deferred<void>;
  command: Option.Option<Atom.AtomResultFn<Effect.Effect<void>, void, never>>;
};
export const makeTransactionCapture = (input: Input): Atom.Atom<TransactionCaptureTask> =>
  Atom.make((get) => {
    const owner: Owner = {
      client: input.client,
      timeZone: input.timeZone,
      get,
      draft: input.initial,
      status: "editing",
      created: Option.none(),
      attempt: Option.none(),
      active: false,
      generation: 0,
      stopped: Deferred.makeUnsafe<void>(),
      command: Option.none(),
    };
    get.addFinalizer(() => dispose(owner));
    return present(owner);
  });
const locked = (owner: Owner): boolean =>
  owner.status === "saving" || owner.status === "unknown" || owner.status === "saved";
const notify = (owner: Owner): void => {
  if (owner.active) owner.get.setSelf(present(owner));
};
const present = (owner: Owner): TransactionCaptureTask => ({
  draft: owner.draft,
  timeZone: owner.timeZone,
  saving: owner.status === "saving",
  uncertain: owner.status === "unknown",
  rejected: owner.status === "rejected",
  invalid: owner.status === "invalid",
  locked: locked(owner),
  created: owner.created,
  attempt: owner.attempt,
  change: (draft) => {
    if (!owner.active || locked(owner)) return;
    owner.draft = draft;
    notify(owner);
  },
  submit: (submission) => submit(owner, submission),
  restart: ({ draft, timeZone }) => {
    if (!owner.active || owner.status === "saving") return;
    owner.generation += 1;
    owner.status = "editing";
    owner.draft = draft;
    owner.timeZone = timeZone;
    owner.created = Option.none();
    owner.attempt = Option.none();
    notify(owner);
  },
  resume: () => {
    if (!owner.active || owner.status !== "unknown") return;
    owner.status = "editing";
    owner.generation += 1;
    notify(owner);
  },
  mount: () => {
    owner.active = true;
    owner.stopped = Deferred.makeUnsafe<void>();
    return () => dispose(owner);
  },
});
const dispose = (owner: Owner): void => {
  if (owner.status === "saving") {
    owner.status = "unknown";
    owner.attempt = Option.some(owner.draft);
    notify(owner);
  }
  owner.active = false;
  owner.generation += 1;
  Deferred.doneUnsafe(owner.stopped, Effect.void);
  Option.map(owner.command, (command) => owner.get.set(command, Atom.Interrupt));
};
const prepare = (
  owner: Owner,
  categories: ReadonlyArray<Category>
): Option.Option<CanonicalInput<"transactions.createTransaction">> => {
  const draft = owner.draft;
  const money = parseMoneyInput({ text: draft.amount, currency: draft.currency });
  const zoned = DateTime.makeZoned(`${draft.occurredOn}T00:00:00.000Z`, {
    timeZone: owner.timeZone,
    adjustForTimeZone: true,
  });
  if (
    Option.isNone(money) ||
    Option.isNone(zoned) ||
    DateTime.formatIsoDate(zoned.value) !== draft.occurredOn
  ) {
    return Option.none();
  }
  const input: CanonicalInput<"transactions.createTransaction"> = {
    payload: {
      money: money.value,
      direction: draft.direction,
      counterparty: Option.fromNullishOr(draft.counterparty.trim() || undefined),
      notes: Option.fromNullishOr(draft.notes.trim() || undefined),
      categoryId: Option.fromUndefinedOr(
        categories.find((category) => category.id === draft.categoryId)
      ).pipe(Option.map((category) => category.id)),
      occurredAt: DateTime.toUtc(zoned.value),
    },
  };
  return isCanonicalInput("transactions.createTransaction", input)
    ? Option.some(input)
    : Option.none();
};
const refused = (cause: Cause.Cause<unknown>): boolean => {
  const error = Cause.findErrorOption(cause);
  return (
    Option.isSome(error) &&
    (Predicate.isTagged(error.value, "ValidationFailed") ||
      Predicate.isTagged(error.value, "NotFound") ||
      Predicate.isTagged(error.value, "ResourceLimited"))
  );
};
const submit = (owner: Owner, submission: Submission): void => {
  if (!owner.active || locked(owner)) return;
  const input = prepare(owner, submission.categories);
  if (Option.isNone(input)) {
    owner.status = "invalid";
    notify(owner);
    return;
  }
  owner.status = "saving";
  notify(owner);
  const generation = owner.generation;
  const work = Effect.gen(function* () {
    const outcome = yield* Effect.gen(function* () {
      const client = yield* owner.client;
      return yield* client.transactions.createTransaction(input.value);
    }).pipe(Effect.exit);
    if (!owner.active || owner.generation !== generation) return;
    if (outcome._tag === "Failure") {
      if (Cause.hasInterruptsOnly(outcome.cause)) return;
      owner.status = refused(outcome.cause) ? "rejected" : "unknown";
      if (owner.status === "unknown") owner.attempt = Option.some(owner.draft);
      notify(owner);
      return;
    }
    yield* complete(owner, { generation, submission, created: outcome.value.data });
  }).pipe(Effect.raceFirst(Deferred.await(owner.stopped)));
  if (Option.isNone(owner.command)) {
    const command = owner.client.runtime.fn<Effect.Effect<void>>()((effect) => effect, {
      concurrent: false,
    });
    owner.command = Option.some(command);
    owner.get.mount(command);
  }
  owner.get.set(Option.getOrThrow(owner.command), work);
};

const complete = (
  owner: Owner,
  {
    generation,
    submission,
    created,
  }: Readonly<{ generation: number; submission: Submission; created: Created }>
): Effect.Effect<void> =>
  Effect.gen(function* () {
    owner.status = "saved";
    owner.created = Option.some(created);
    notify(owner);
    yield* Effect.sync(submission.invalidate).pipe(
      Effect.catchCause(() => Effect.sync(() => reportBrowserDefect("client_defect")))
    );
    if (!owner.active || owner.generation !== generation) return;
    yield* Effect.sync(() => submission.onCreated(created)).pipe(
      Effect.catchCause(() => Effect.sync(() => reportBrowserDefect("client_defect")))
    );
  });

export type CaptureRetention = Readonly<{
  resource: Option.Option<Atom.Atom<TransactionCaptureTask>>;
  identity: Option.Option<string>;
  mount: (input: Input, identity: string) => () => void;
}>;
type RetainedCapture = Readonly<{
  identity: string;
  resource: Atom.Atom<TransactionCaptureTask>;
  release: () => void;
}>;
export const makeCaptureRetention = (): Atom.Atom<CaptureRetention> =>
  Atom.make((get) => {
    let current: Option.Option<RetainedCapture> = Option.none();
    get.addFinalizer(() => Option.map(current, (retained) => retained.release()));
    const mount = (input: Input, identity: string): (() => void) => {
      if (
        Option.isNone(current) ||
        (!get.once(current.value.resource).locked && current.value.identity !== identity)
      ) {
        Option.map(current, (retained) => retained.release());
        const resource = makeTransactionCapture(input);
        current = Option.some({ identity, resource, release: get.registry.mount(resource) });
        get.setSelf({ resource: Option.some(resource), identity: Option.some(identity), mount });
      }
      return get.once(Option.getOrThrow(current).resource).mount();
    };
    return { resource: Option.none(), identity: Option.none(), mount };
  });
