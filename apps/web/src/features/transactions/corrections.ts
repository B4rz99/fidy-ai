import { Array, Cause, type Context, Deferred, Effect, Option, Predicate } from "effect";
import { type AsyncResult, Atom, Reactivity } from "effect/reactivity";
import { type CanonicalInput, type CanonicalSuccess, type FidyClient } from "@/transport/client";
import { isCanonicalInput } from "@/transport/canonical-input";
import { readFreshQuery } from "@/transport/fresh-query";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import type { HistoryCommand, HistoryState } from "./history";
import type { Transaction } from "./presentation";

type Client = Context.Service.Shape<FidyClient>;
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
  resetWorkspace: () => void;
  reviewingDeletion: Option.Option<Transaction["id"]>;
  reviewDeletion: (id: Transaction["id"]) => boolean;
  cancelDeletion: () => void;
  confirmDeletion: (id: Transaction["id"], onDeleted: () => void) => void;
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
type Work = Effect.Effect<void, never, Reactivity.Reactivity>;
type Owner = Input & {
  get: Atom.AtomContext;
  command: Option.Option<Atom.AtomResultFn<Work, void, never>>;
  status: Status;
  inlineTransaction: Option.Option<Transaction["id"]>;
  workspaceGeneration: number;
  active: boolean;
  deletion: Option.Option<Transaction["id"]>;
  reviewGeneration: number;
  affected: ReadonlyArray<Transaction["id"]>;
  cancelDeletion: () => void;
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
      deletion: Option.none(),
      reviewGeneration: 0,
      affected: [],
      cancelDeletion: () => cancelDeletion(owner),
      generation: 0,
      stopped: Deferred.makeUnsafe<void>(),
    };
    get.addFinalizer(() => dispose(owner));
    return present(owner);
  });
const present = (owner: Owner): TransactionCorrections => {
  const generation = owner.workspaceGeneration;
  const reviewGeneration = owner.reviewGeneration;
  return {
    status: owner.status,
    locked:
      Option.isSome(owner.deletion) || (owner.status !== "idle" && owner.status !== "recovered"),
    reviewingDeletion: owner.deletion,
    reviewDeletion: (id) => reviewDeletion(owner, id),
    cancelDeletion: owner.cancelDeletion,
    confirmDeletion: (id, onDeleted) => {
      if (reviewGeneration === owner.reviewGeneration) confirmDeletion(owner, id, onDeleted);
    },
    inlineTransaction: owner.inlineTransaction,
    workspaceGeneration: owner.workspaceGeneration,
    submit: (correction) => {
      if (owner.workspaceGeneration === generation) submit(owner, correction);
    },
    recover: () => recover(owner, "recovery"),
    resetWorkspace: () => resetWorkspace(owner),
    mount: () => {
      owner.active = true;
      owner.stopped = Deferred.makeUnsafe<void>();
      return () => dispose(owner);
    },
  };
};
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
const available = (owner: Owner): boolean =>
  owner.active &&
  Option.isNone(owner.deletion) &&
  (owner.status === "idle" || owner.status === "recovered");
const resetWorkspace = (owner: Owner): void => {
  if (!available(owner)) return;
  owner.workspaceGeneration += 1;
  owner.inlineTransaction = Option.none();
  notify(owner);
};
const submit = (owner: Owner, correction: Correction): void => {
  if (!available(owner)) return;
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
  owner.affected =
    correction.kind === "single"
      ? [correction.transaction.id]
      : correction.transactions.map(({ id }) => id);
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
    owner.get.set(owner.historyAction, "refresh-pages");
    const results = yield* Effect.all(
      [
        readFreshQuery({ registry: owner.get.registry, query: owner.categories }),
        readFreshQuery({ registry: owner.get.registry, query: owner.firstPage }),
      ],
      { concurrency: 2 }
    );
    if (results.every(Boolean)) results.push(yield* refreshedHistory(owner));
    if (results.every(Boolean)) results.push(yield* readAffectedIdentities(owner));
    if (!live(owner, generation)) return;
    if (results.every(Boolean)) owner.affected = [];
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
  cancelDeletion(owner);
  const afterRejection = owner.status === "rejected";
  owner.status = afterRejection ? "refreshing" : "recovering";
  notify(owner);
  run(owner, reread(owner, owner.generation, afterRejection ? "rejected" : reason));
};

const reviewDeletion = (owner: Owner, id: Transaction["id"]): boolean => {
  if (
    !owner.active ||
    Option.isSome(owner.deletion) ||
    (owner.status !== "idle" && owner.status !== "recovered")
  ) {
    return false;
  }
  owner.reviewGeneration += 1;
  owner.deletion = Option.some(id);
  notify(owner);
  return true;
};
const cancelDeletion = (owner: Owner): void => {
  owner.reviewGeneration += 1;
  owner.deletion = Option.none();
  notify(owner);
};
const confirmDeletion = (owner: Owner, id: Transaction["id"], onDeleted: () => void): void => {
  if (
    !owner.active ||
    !Option.contains(owner.deletion, id) ||
    (owner.status !== "idle" && owner.status !== "recovered")
  ) {
    return;
  }
  owner.reviewGeneration += 1;
  owner.deletion = Option.none();
  owner.inlineTransaction = Option.none();
  owner.affected = [id];
  owner.status = "saving";
  notify(owner);
  const generation = owner.generation;
  run(
    owner,
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        Effect.gen(function* () {
          const client = yield* owner.client;
          yield* client.transactions.deleteTransaction({ params: { id } });
        })
      );
      if (!live(owner, generation)) return;
      if (result._tag === "Failure") {
        yield* Reactivity.invalidate(["transaction-detail"]);
        owner.status = rejected(result.cause) ? "rejected" : "uncertain";
        notify(owner);
        return;
      }
      onDeleted();
      yield* reread(owner, generation, "saved");
    })
  );
};

const readAffectedIdentities = (owner: Owner): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const history = owner.get.once(owner.history).query;
    if (!fresh(history)) return false;
    const observed = new Set(history.value.data.map(({ id }) => id));
    const missing = owner.affected.filter((id) => !observed.has(id));
    if (missing.length === 0) return true;
    const client = yield* owner.client;
    for (const id of missing) {
      if (!(yield* readIdentity(client, id))) return false;
    }
    return true;
  });

const readIdentity = Effect.fnUntraced(function* (client: Client, id: Transaction["id"]) {
  const result = yield* Effect.exit(client.transactions.getTransaction({ params: { id } }));
  if (result._tag === "Success") return result.value.data.id === id;
  if (Cause.hasDies(result.cause) || Cause.hasInterrupts(result.cause)) return false;
  const error = Cause.findErrorOption(result.cause);
  return Option.isSome(error) && Predicate.isTagged(error.value, "NotFound");
});
