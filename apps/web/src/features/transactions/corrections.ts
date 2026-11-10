import { Array, Cause, Deferred, Effect, Option, Predicate } from "effect";
import { type AsyncResult, Atom } from "effect/reactivity";
import { type CanonicalInput, type CanonicalSuccess, type FidyClient } from "@/transport/client";
import { isCanonicalInput } from "@/transport/canonical-input";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import type { HistoryCommand, HistoryState } from "./history";
import type { Transaction } from "./presentation";

type Revision = Pick<Transaction, "id" | "revision">;
type Changes = CanonicalInput<"transactions.updateTransaction">["payload"]["changes"];
type Correction =
  | Readonly<{
      kind: "single";
      origin: "inline" | "editor";
      transaction: Revision;
      changes: Changes;
    }>
  | Readonly<{
      kind: "bulk";
      transactions: ReadonlyArray<Revision>;
      changes: Changes;
    }>;
type Status =
  | "idle"
  | "saving"
  | "rejected"
  | "uncertain"
  | "recovering"
  | "refreshing"
  | "recovered";
export type TransactionCorrections = Readonly<{
  status: Status;
  locked: boolean;
  inlineTransaction: Option.Option<Transaction["id"]>;
  workspaceGeneration: number;
  submit: (correction: Correction) => void;
  recover: () => void;
  refreshAfterMutation: () => void;
  mount: () => () => void;
}>;
type Query<A, E> = Atom.Atom<AsyncResult.AsyncResult<A, E>>;
type Input = Readonly<{
  client: FidyClient;
  firstPage: Query<CanonicalSuccess<"transactions.listTransactions">, unknown>;
  categories: Query<CanonicalSuccess<"categories.listCategories">, unknown>;
  history: Atom.Atom<HistoryState>;
  historyAction: Atom.Writable<Option.Option<void>, HistoryCommand>;
  saved: (transactions: ReadonlyArray<Transaction>) => void;
}>;
type Work = Effect.Effect<void>;
type Owner = Input & {
  get: Atom.AtomContext;
  command: Option.Option<Atom.AtomResultFn<Work, void, never>>;
  status: Status;
  inlineTransaction: Option.Option<Transaction["id"]>;
  workspaceGeneration: number;
  active: boolean;
  generation: number;
  stopped: Deferred.Deferred<void>;
};
type Write =
  | Readonly<{
      kind: "single";
      input: CanonicalInput<"transactions.updateTransaction">;
    }>
  | Readonly<{
      kind: "bulk";
      input: CanonicalInput<"transactions.updateTransactions">;
    }>;
/** Owns Correction admission and uncertainty across editing paths. Only a successful explicit
 * canonical reread releases an uncertain write; disposing cannot undo a request already sent.
 */
export const makeTransactionCorrections = (input: Input): Atom.Atom<TransactionCorrections> =>
  Atom.make((get) => {
    const owner: Owner = {
      ...input,
      command: Option.none(),
      get,
      status: "idle",
      inlineTransaction: Option.none(),
      workspaceGeneration: 0,
      active: false,
      generation: 0,
      stopped: Deferred.makeUnsafe<void>(),
    };
    get.addFinalizer(() => dispose(owner));
    return present(owner);
  });
const present = (owner: Owner): TransactionCorrections => ({
  status: owner.status,
  locked: owner.status !== "idle" && owner.status !== "recovered",
  inlineTransaction: owner.inlineTransaction,
  workspaceGeneration: owner.workspaceGeneration,
  submit: (correction) => submit(owner, correction),
  recover: () => recover(owner, "recovery"),
  refreshAfterMutation: () => recover(owner, "saved"),
  mount: () => {
    owner.active = true;
    owner.stopped = Deferred.makeUnsafe<void>();
    return () => dispose(owner);
  },
});
const notify = (owner: Owner): void => {
  if (owner.active) owner.get.setSelf(present(owner));
};
const dispose = (owner: Owner): void => {
  owner.active = false;
  owner.generation += 1;
  Deferred.doneUnsafe(owner.stopped, Effect.void);
  Option.map(owner.command, (command) => owner.get.set(command, Atom.Interrupt));
};
const correctionCommand = (owner: Owner): Atom.AtomResultFn<Work, void, never> => {
  if (Option.isSome(owner.command)) return owner.command.value;
  const command = owner.client.runtime.fn<Work>()((work) => work, { concurrent: false });
  owner.command = Option.some(command);
  owner.get.mount(command);
  return command;
};
const run = (owner: Owner, work: Work): void => {
  owner.get.set(
    correctionCommand(owner),
    work.pipe(Effect.raceFirst(Deferred.await(owner.stopped)))
  );
};
const live = (owner: Owner, generation: number): boolean =>
  owner.active && owner.generation === generation;
const fresh = <A, E>(
  query: ReturnType<typeof presentCanonicalQuery<A, E>>
): query is Extract<
  ReturnType<typeof presentCanonicalQuery<A, E>>,
  {
    _tag: "Ready";
  }
> => query._tag === "Ready" && !query.waiting && Option.isNone(query.refreshFailure);
const currentRevisions = (owner: Owner, correction: Correction): boolean => {
  const history = owner.get.once(owner.history).query;
  const categories = presentCanonicalQuery(owner.get.once(owner.categories));
  if (!fresh(history) || !fresh(categories)) return false;
  const records = correction.kind === "single" ? [correction.transaction] : correction.transactions;
  return (
    records.length > 0 &&
    new Set(records.map((record) => record.id)).size === records.length &&
    records.every((record) =>
      history.value.data.some(
        (current) => current.id === record.id && current.revision === record.revision
      )
    )
  );
};
const prepare = (correction: Correction): Option.Option<Write> => {
  if (Object.keys(correction.changes).length === 0) return Option.none();
  if (correction.kind === "single") {
    const input = {
      params: { id: correction.transaction.id },
      payload: {
        expectedRevision: correction.transaction.revision,
        changes: correction.changes,
      },
    };
    return isCanonicalInput("transactions.updateTransaction", input)
      ? Option.some({ kind: "single", input })
      : Option.none();
  }
  const input = {
    payload: {
      transactions: correction.transactions.map((record) => ({
        id: record.id,
        expectedRevision: record.revision,
      })),
      changes: correction.changes,
    },
  };
  if (!Array.isReadonlyArrayNonEmpty(input.payload.transactions)) return Option.none();
  const validated = {
    payload: { transactions: input.payload.transactions, changes: input.payload.changes },
  };
  return isCanonicalInput("transactions.updateTransactions", validated)
    ? Option.some({ kind: "bulk", input: validated })
    : Option.none();
};
const write = Effect.fnUntraced(function* (owner: Owner, command: Write) {
  const client = yield* owner.client;
  if (command.kind === "single") {
    const result = yield* client.transactions.updateTransaction(command.input);
    return [result.data];
  }
  yield* client.transactions.updateTransactions(command.input);
  return [];
});
const rejected = (cause: Cause.Cause<unknown>): boolean => {
  const failure = Cause.findErrorOption(cause);
  return (
    Option.isSome(failure) &&
    (Predicate.isTagged(failure.value, "ValidationFailed") ||
      Predicate.isTagged(failure.value, "NotFound") ||
      Predicate.isTagged(failure.value, "ResourceLimited"))
  );
};
const submit = (owner: Owner, correction: Correction): void => {
  if (!owner.active || (owner.status !== "idle" && owner.status !== "recovered")) return;
  owner.inlineTransaction =
    correction.kind === "single" && correction.origin === "inline"
      ? Option.some(correction.transaction.id)
      : Option.none();
  const command = prepare(correction);
  if (!currentRevisions(owner, correction) || Option.isNone(command)) {
    owner.status = "refreshing";
    notify(owner);
    run(owner, reread(owner, owner.generation, "rejected"));
    return;
  }
  owner.status = "saving";
  notify(owner);
  const generation = owner.generation;
  run(
    owner,
    Effect.gen(function* () {
      const result = yield* Effect.exit(write(owner, command.value));
      if (!live(owner, generation)) return;
      if (result._tag === "Failure") {
        if (rejected(result.cause)) {
          yield* reread(owner, generation, "rejected");
        } else {
          owner.status = "uncertain";
          notify(owner);
        }
        return;
      }
      if (command.value.kind === "single") owner.saved(result.value);
      yield* reread(owner, generation, "saved");
      if (command.value.kind === "bulk" && live(owner, generation)) {
        const records = yield* readSavedSelection(owner, command.value.input.payload.transactions);
        if (live(owner, generation)) owner.saved(records);
      }
    })
  );
};
// SWR publishes the refreshed source asynchronously; its cached terminal result is not recovery.
const nextResult = <A, E>(
  owner: Owner,
  query: Query<A, E>,
  previous: AsyncResult.AsyncResult<A, E>
): Effect.Effect<boolean> =>
  Effect.callback((resume) => {
    const completed = (result: AsyncResult.AsyncResult<A, E>): boolean =>
      result !== previous && result._tag !== "Initial" && !result.waiting;
    const current = owner.get.once(query);
    if (completed(current)) return resume(Effect.succeed(current._tag === "Success"));
    const unsubscribe = owner.get.registry.subscribe(query, (result) => {
      if (completed(result)) resume(Effect.succeed(result._tag === "Success"));
    });
    return Effect.sync(unsubscribe);
  });
const refreshedHistory = (owner: Owner): Effect.Effect<boolean> =>
  Effect.callback((resume) => {
    const observe = (state: HistoryState): void => {
      if (state.query._tag !== "Ready") return resume(Effect.succeed(false));
      if (state.query.waiting || state.continuation === "loading") return;
      resume(
        Effect.succeed(
          state.continuation !== "failure" && Option.isNone(state.query.refreshFailure)
        )
      );
    };
    const unsubscribe = owner.get.registry.subscribe(owner.history, observe);
    observe(owner.get.once(owner.history));
    return Effect.sync(unsubscribe);
  });
const readSavedSelection = (
  owner: Owner,
  selected: CanonicalInput<"transactions.updateTransactions">["payload"]["transactions"]
): Effect.Effect<ReadonlyArray<Transaction>> =>
  Effect.gen(function* () {
    if (!(yield* refreshedHistory(owner))) return [];
    const { query } = owner.get.once(owner.history);
    if (query._tag !== "Ready") return [];
    const revisions = new Map(selected.map(({ id, expectedRevision }) => [id, expectedRevision]));
    return query.value.data.filter(({ id, revision }) => {
      const previous = revisions.get(id);
      return previous !== undefined && revision > previous;
    });
  });
const reread = (
  owner: Owner,
  generation: number,
  reason: "saved" | "rejected" | "recovery"
): Work =>
  Effect.gen(function* () {
    const afterRejection = reason === "rejected";
    const statuses = afterRejection
      ? ({ waiting: "refreshing", success: "recovered", failure: "rejected" } as const)
      : ({ waiting: "recovering", success: "idle", failure: "uncertain" } as const);
    if (!afterRejection) owner.workspaceGeneration += 1;
    owner.status = statuses.waiting;
    notify(owner);
    const categories = owner.get.once(owner.categories);
    const firstPage = owner.get.once(owner.firstPage);
    owner.get.refresh(owner.categories);
    owner.get.set(owner.historyAction, "refresh");
    const results = yield* Effect.all([
      nextResult(owner, owner.categories, categories),
      nextResult(owner, owner.firstPage, firstPage),
    ]);
    if (reason !== "saved" && results.every(Boolean)) results.push(yield* refreshedHistory(owner));
    if (!live(owner, generation)) return;
    owner.status = results.every(Boolean) ? statuses.success : statuses.failure;
    notify(owner);
  });
const recover = (owner: Owner, reason: "recovery" | "saved"): void => {
  if (
    !owner.active ||
    owner.status === "saving" ||
    owner.status === "recovering" ||
    owner.status === "refreshing"
  ) {
    return;
  }
  const afterRejection = owner.status === "rejected";
  owner.status = afterRejection ? "refreshing" : "recovering";
  notify(owner);
  run(owner, reread(owner, owner.generation, afterRejection ? "rejected" : reason));
};
