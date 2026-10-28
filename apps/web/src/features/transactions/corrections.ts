import { browserCrypto } from "@/browser/crypto";
import { Array, Cause, type Context, Deferred, Effect, Option, Predicate, Schema } from "effect";
import { type AsyncResult, Atom } from "effect/reactivity";
import {
  AtomicBatchCallId,
  AtomicBatchRejected,
  type CanonicalInput,
  type CanonicalSuccess,
  type FidyClient,
} from "@/transport/client";
import { isCanonicalInput } from "@/transport/canonical-input";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import type { HistoryState } from "./history";
import type { Transaction } from "./presentation";

type Revision = Pick<Transaction, "id" | "revision">;
type Changes = CanonicalInput<"transactions.updateTransaction">["payload"]["changes"];
type Correction =
  | Readonly<{ kind: "single"; transaction: Revision; changes: Changes }>
  | Readonly<{ kind: "bulk"; transactions: ReadonlyArray<Revision>; changes: Changes }>;
type Status = "idle" | "saving" | "rejected" | "uncertain" | "recovering";
export type TransactionCorrections = Readonly<{
  status: Status;
  locked: boolean;
  affected: ReadonlyArray<Transaction["id"]>;
  submit: (correction: Correction) => void;
  recover: () => void;
  mount: () => () => void;
}>;
type Client = Context.Service.Shape<FidyClient>;
type PageFailure = Effect.Error<ReturnType<Client["transactions"]["listTransactions"]>>;
type CategoryFailure = Effect.Error<ReturnType<Client["categories"]["listCategories"]>>;
type Query<A, E> = Atom.Atom<AsyncResult.AsyncResult<A, E>>;
type Input = Readonly<{
  client: FidyClient;
  firstPage: Query<CanonicalSuccess<"transactions.listTransactions">, PageFailure>;
  categories: Query<CanonicalSuccess<"categories.listCategories">, CategoryFailure>;
  history: Atom.Atom<HistoryState>;
  historyAction: Atom.Writable<Option.Option<void>, "more" | "retry" | "reset">;
  saved: (kind: Correction["kind"]) => void;
}>;
type Work = Effect.Effect<void>;
type Owner = Input & {
  get: Atom.AtomContext;
  command: Atom.AtomResultFn<Work, void, never>;
  status: Status;
  affected: ReadonlyArray<Transaction["id"]>;
  active: boolean;
  generation: number;
  stopped: Deferred.Deferred<void>;
};
type Write =
  | Readonly<{ kind: "single"; input: CanonicalInput<"transactions.updateTransaction"> }>
  | Readonly<{ kind: "bulk"; input: CanonicalInput<"operations.executeAtomicBatch"> }>;

/** Owns Correction admission and uncertainty across editing paths. Only a successful explicit
 * canonical reread releases an uncertain write; disposing cannot undo a request already sent.
 */
export const makeTransactionCorrections = (input: Input): Atom.Atom<TransactionCorrections> => {
  const command = input.client.runtime.fn<Work>()((work) => work, { concurrent: false });
  return Atom.make((get) => {
    get.mount(command);
    const owner: Owner = {
      ...input,
      command,
      get,
      status: "idle",
      affected: [],
      active: false,
      generation: 0,
      stopped: Deferred.makeUnsafe<void>(),
    };
    get.addFinalizer(() => dispose(owner));
    return present(owner);
  });
};
const present = (owner: Owner): TransactionCorrections => ({
  status: owner.status,
  locked: owner.status !== "idle",
  affected: owner.affected,
  submit: (correction) => submit(owner, correction),
  recover: () => recover(owner),
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
  owner.get.set(owner.command, Atom.Interrupt);
};
const run = (owner: Owner, work: Work): void => {
  owner.get.set(owner.command, work.pipe(Effect.raceFirst(Deferred.await(owner.stopped))));
};
const live = (owner: Owner, generation: number): boolean =>
  owner.active && owner.generation === generation;
const fresh = <A, E>(
  query: ReturnType<typeof presentCanonicalQuery<A, E>>
): query is Extract<ReturnType<typeof presentCanonicalQuery<A, E>>, { _tag: "Ready" }> =>
  query._tag === "Ready" && !query.waiting && Option.isNone(query.refreshFailure);
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
      calls: correction.transactions.map((record) => ({
        callId: Schema.decodeSync(AtomicBatchCallId)(
          Effect.runSync(browserCrypto.randomUUIDv4().pipe(Effect.orDie))
        ),
        operation: "transactions.updateTransaction",
        input: {
          params: { id: record.id },
          payload: { expectedRevision: record.revision, changes: correction.changes },
        },
      })),
    },
  };
  if (
    !Array.isReadonlyArrayNonEmpty(input.payload.calls) ||
    !input.payload.calls.every((call) =>
      isCanonicalInput("transactions.updateTransaction", call.input)
    )
  ) {
    return Option.none();
  }
  const validated = { payload: { calls: input.payload.calls } };
  return isCanonicalInput("operations.executeAtomicBatch", validated)
    ? Option.some({ kind: "bulk", input: validated })
    : Option.none();
};
const write = Effect.fnUntraced(function* (owner: Owner, command: Write) {
  const client = yield* owner.client;
  if (command.kind === "single") yield* client.transactions.updateTransaction(command.input);
  else yield* client.operations.executeAtomicBatch(command.input);
});
const rejected = (cause: Cause.Cause<unknown>, kind: Correction["kind"]): boolean => {
  const failure = Cause.findErrorOption(cause);
  return (
    Option.isSome(failure) &&
    (kind === "bulk"
      ? Schema.is(AtomicBatchRejected)(failure.value)
      : Predicate.isTagged(failure.value, "ValidationFailed") ||
        Predicate.isTagged(failure.value, "NotFound") ||
        Predicate.isTagged(failure.value, "ResourceLimited"))
  );
};
const submit = (owner: Owner, correction: Correction): void => {
  if (!owner.active || owner.status !== "idle") return;
  owner.affected = (
    correction.kind === "single" ? [correction.transaction] : correction.transactions
  ).map((record) => record.id);
  const command = prepare(correction);
  if (!currentRevisions(owner, correction) || Option.isNone(command)) {
    owner.status = "rejected";
    notify(owner);
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
        owner.status = rejected(result.cause, command.value.kind) ? "rejected" : "uncertain";
        notify(owner);
        return;
      }
      owner.saved(command.value.kind);
      yield* reread(owner, generation);
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
const reread = (owner: Owner, generation: number): Work =>
  Effect.gen(function* () {
    owner.status = "recovering";
    notify(owner);
    const categories = owner.get.once(owner.categories);
    const firstPage = owner.get.once(owner.firstPage);
    owner.get.refresh(owner.categories);
    owner.get.set(owner.historyAction, "reset");
    const results = yield* Effect.all([
      nextResult(owner, owner.categories, categories),
      nextResult(owner, owner.firstPage, firstPage),
    ]);
    if (!live(owner, generation)) return;
    owner.status = results.every(Boolean) ? "idle" : "uncertain";
    notify(owner);
  });
const recover = (owner: Owner): void => {
  if (!owner.active || owner.status === "saving" || owner.status === "recovering") return;
  owner.status = "recovering";
  notify(owner);
  run(owner, reread(owner, owner.generation));
};
