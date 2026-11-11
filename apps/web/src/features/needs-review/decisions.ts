import { reviewContextKey, reviewCountKey, reviewItemKey, reviewWorkspaceKey } from "./query-keys";
import {
  Cause,
  type Context,
  DateTime,
  Deferred,
  Effect,
  Option,
  Predicate,
  Schema,
  Semaphore,
} from "effect";
import { AsyncResult, Atom, Reactivity } from "effect/reactivity";
import {
  type CanonicalSuccess,
  type FidyClient,
  ReviewCommand,
  ReviewDraft,
} from "@/transport/client";
import { type Command, type Detail, type Draft, type Item, creation, emptyDraft } from "./model";

type Feedback = "saved" | "saving" | "unsaved" | "failed" | "uncertain";
const invalidateItems = ({
  ids,
  countsChanged,
}: Readonly<{
  ids: ReadonlyArray<Item["id"]>;
  countsChanged: boolean;
}>): Effect.Effect<void, never, Reactivity.Reactivity> =>
  Reactivity.invalidate([
    reviewWorkspaceKey,
    ...ids.map(reviewItemKey),
    ...(countsChanged ? [reviewCountKey, reviewContextKey] : []),
  ]);
type Completion = Readonly<{ ids: ReadonlyArray<Item["id"]> }>;
export type ReviewEditorState = Readonly<{
  detail: Detail;
  draft: Draft;
  feedback: Feedback;
  locked: boolean;
  canCreate: boolean;
  recovering: boolean;
  change: (draft: Draft) => void;
  recover: () => void;
}>;
export type ReviewDecisions = Readonly<{
  locked: boolean;
  feedback: string;
  undoCount: number;
  completed: Option.Option<Completion>;
  editor: (detail: Detail) => ReviewEditorState;
  decide: (detail: Detail, kind: "Create" | "Skip") => void;
  bulk: (restore: boolean, items: ReadonlyArray<Item>) => void;
  undoSkip: () => void;
  recover: () => void;
  mount: () => () => void;
}>;
type WorkspaceFailure = Effect.Error<
  ReturnType<Context.Service.Shape<FidyClient>["ingestion"]["getReviewWorkspace"]>
>;
export type ReviewWorkspaceQuery = Atom.Atom<
  AsyncResult.AsyncResult<CanonicalSuccess<"ingestion.getReviewWorkspace">, WorkspaceFailure>
>;
type Entry = {
  detail: Detail;
  draft: Draft;
  wanted: Option.Option<Draft>;
  feedback: Feedback;
  acting: boolean;
  recovering: boolean;
  version: number;
  nextAutosaveAt: number;
  permit: Semaphore.Semaphore;
  retired: Deferred.Deferred<void>;
};
type Work = Effect.Effect<void, never, Reactivity.Reactivity>;
type Owner = {
  client: FidyClient;
  created: () => void;
  get: Atom.AtomContext;
  query: ReviewWorkspaceQuery;
  command: Atom.AtomResultFn<Work, void, never>;
  entries: Map<Item["id"], Entry>;
  expiries: Map<Item["id"], DateTime.Utc>;
  active: boolean;
  generation: number;
  stopped: Deferred.Deferred<void>;
  phase: "idle" | "writing" | "uncertain" | "recovering";
  feedback: string;
  undo: ReadonlyArray<Item>;
  completed: Option.Option<Completion>;
};
const autosaveMilliseconds = 200;
const autosaveIntervalMilliseconds = 1000;
const maximumTimerMilliseconds = 2_147_483_647;
const now = (): number => DateTime.toEpochMillis(DateTime.nowUnsafe());
const draftFor = (detail: Detail): Draft =>
  Option.getOrElse(
    Option.orElse(detail.draft, () =>
      Option.map(detail.suggestions, (draft) => ({
        ...draft,
        amount: draft.amount.replace(".", ","),
      }))
    ),
    emptyDraft
  );
const makeEntry = (detail: Detail): Entry => ({
  detail,
  draft: draftFor(detail),
  wanted: Option.none(),
  feedback: "saved",
  acting: false,
  recovering: false,
  version: 0,
  nextAutosaveAt: 0,
  permit: Semaphore.makeUnsafe(1),
  retired: Deferred.makeUnsafe<void>(),
});
const blocked = (entry: Entry): boolean =>
  entry.feedback === "failed" || entry.feedback === "uncertain" || entry.recovering;
const current = (owner: Owner, entry: Entry): boolean =>
  owner.active &&
  owner.entries.get(entry.detail.item.id) === entry &&
  now() < DateTime.toEpochMillis(entry.detail.item.expiresAt);
const notify = (owner: Owner): void => {
  if (owner.active) owner.get.setSelf(present(owner));
};
const run = (owner: Owner, work: Work): void => {
  if (owner.active) {
    owner.get.set(owner.command, work.pipe(Effect.raceFirst(Deferred.await(owner.stopped))));
  }
};
const dispose = (owner: Owner): void => {
  owner.active = false;
  owner.generation += 1;
  Deferred.doneUnsafe(owner.stopped, Effect.void);
  owner.entries.clear();
  owner.expiries.clear();
  owner.undo = [];
  owner.completed = Option.none();
  owner.get.set(owner.command, Atom.Interrupt);
};

/** One panel/page owns decisions until disposal. Hiding it or changing selection does not dispose
 * it. Disposal cancels unsent work; a sent mutation may still commit and must be reread on return.
 */
export const makeReviewDecisions = ({
  client,
  query,
  created,
}: Readonly<{
  client: FidyClient;
  query: ReviewWorkspaceQuery;
  created: () => void;
}>): Atom.Atom<ReviewDecisions> => {
  const command = client.runtime.fn<Work>()((work) => work, { concurrent: true });
  return Atom.make((get) => {
    get.mount(command);
    const owner: Owner = {
      client,
      query,
      created,
      get,
      command,
      entries: new Map(),
      expiries: new Map(),
      active: false,
      generation: 0,
      stopped: Deferred.makeUnsafe<void>(),
      phase: "idle",
      feedback: "",
      undo: [],
      completed: Option.none(),
    };
    get.subscribe(query, (result) => {
      if (!AsyncResult.isSuccess(result) || result.waiting) return;
      pruneUndo(owner, result.value.data.items);
      notify(owner);
    });
    get.addFinalizer(() => dispose(owner));
    return present(owner);
  });
};
const present = (owner: Owner, generation = owner.generation): ReviewDecisions => ({
  locked: owner.phase !== "idle",
  feedback: owner.feedback,
  undoCount: eligibleUndo(owner).length,
  completed: owner.completed,
  editor: (detail) => editorState(owner, detail, generation),
  decide: (detail, kind) => {
    if (liveGeneration(owner, generation)) decide(owner, detail, kind);
  },
  bulk: (restore, items) => {
    if (liveGeneration(owner, generation)) bulk(owner, items, restore ? "Restore" : "Skip");
  },
  undoSkip: () => {
    if (!liveGeneration(owner, generation) || owner.phase !== "idle") return;
    const items = eligibleUndo(owner);
    owner.undo = [];
    bulk(owner, items, "Undo");
    notify(owner);
  },
  recover: () => {
    if (liveGeneration(owner, generation)) recoverWorkspace(owner);
  },
  mount: () => {
    owner.stopped = Deferred.makeUnsafe<void>();
    owner.active = true;
    notify(owner);
    return () => dispose(owner);
  },
});
const selectedEntry = (owner: Owner, detail: Detail): Entry => {
  const observation = originalExpiry(owner, detail);
  const entry = owner.entries.get(detail.item.id);
  if (entry === undefined) return makeEntry(observation);
  const newer = detail.revision > entry.detail.revision;
  return newer && entry.feedback === "saved" && !entry.acting && !entry.recovering
    ? makeEntry(observation)
    : entry;
};
const editorState = (
  owner: Owner,
  detail: Detail,
  generation = owner.generation
): ReviewEditorState => {
  const binding = {
    observed: Option.fromUndefinedOr(owner.entries.get(detail.item.id)),
    generation,
  };
  const entry = selectedEntry(owner, detail);
  const superseded = detail.revision > entry.detail.revision;
  return {
    detail: entry.detail,
    draft: entry.draft,
    feedback: superseded ? "failed" : entry.feedback,
    locked:
      owner.phase !== "idle" ||
      blocked(entry) ||
      entry.acting ||
      superseded ||
      now() >= DateTime.toEpochMillis(entry.detail.item.expiresAt),
    canCreate: Option.isSome(creation({ detail: entry.detail, draft: entry.draft })),
    recovering: entry.recovering,
    change: (draft) => {
      if (editorState(owner, detail).locked || !bindEntry(owner, entry, binding)) {
        return;
      }
      changeDraft(owner, entry.detail, draft);
    },
    recover: () => {
      if (owner.phase === "idle" && bindEntry(owner, entry, binding)) {
        recoverItem(owner, entry.detail);
      }
    },
  };
};
const bindEntry = (
  owner: Owner,
  entry: Entry,
  binding: Readonly<{ observed: Option.Option<Entry>; generation: number }>
): boolean => {
  if (!liveGeneration(owner, binding.generation) || itemExpired(entry.detail.item)) return false;
  const retained = owner.entries.get(entry.detail.item.id);
  if (retained !== Option.getOrUndefined(binding.observed) && retained !== entry) return false;
  if (retained !== entry) replaceEntry(owner, entry);
  return true;
};
const retain = (owner: Owner, detail: Detail): Entry => {
  const entry = selectedEntry(owner, detail);
  if (owner.entries.get(detail.item.id) !== entry) {
    replaceEntry(owner, entry);
  }
  return entry;
};
const expireEntry = (owner: Owner, entry: Entry): Work =>
  Effect.gen(function* () {
    const deadline = DateTime.toEpochMillis(entry.detail.item.expiresAt);
    while (now() < deadline) {
      yield* Effect.sleep(Math.min(deadline - now(), maximumTimerMilliseconds));
    }
    if (owner.entries.get(entry.detail.item.id) !== entry) return;
    owner.entries.delete(entry.detail.item.id);
    owner.undo = owner.undo.filter((item) => item.id !== entry.detail.item.id);
    notify(owner);
  }).pipe(Effect.raceFirst(Deferred.await(entry.retired)));
const originalItem = (owner: Owner, item: Item): Item => ({
  ...item,
  expiresAt: owner.expiries.get(item.id) ?? item.expiresAt,
});
const retainExpiry = (owner: Owner, item: Item): Item => {
  const original = originalItem(owner, item);
  owner.expiries.set(item.id, original.expiresAt);
  return original;
};
const originalExpiry = (owner: Owner, detail: Detail): Detail => ({
  ...detail,
  item: originalItem(owner, detail.item),
});
const replaceEntry = (owner: Owner, entry: Entry): void => {
  entry.detail = { ...entry.detail, item: retainExpiry(owner, entry.detail.item) };
  const previous = owner.entries.get(entry.detail.item.id);
  if (previous !== undefined) Deferred.doneUnsafe(previous.retired, Effect.void);
  owner.entries.set(entry.detail.item.id, entry);
  pruneUndo(owner, [entry.detail.item]);
  run(owner, expireEntry(owner, entry));
};
const changeDraft = (owner: Owner, detail: Detail, draft: Draft): void => {
  if (!owner.active || editorState(owner, detail).locked) return;
  const entry = retain(owner, detail);
  if (!current(owner, entry) || entry.detail.item.status !== "pending") return;
  entry.draft = draft;
  entry.wanted = Option.some(draft);
  entry.feedback = "unsaved";
  entry.version += 1;
  const version = entry.version;
  run(
    owner,
    Effect.sleep(Math.max(autosaveMilliseconds, entry.nextAutosaveAt - now())).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          version === entry.version ? flush(owner, entry, Option.some(version)) : Effect.void
        )
      )
    )
  );
  notify(owner);
};
const reject = (entry: Entry, cause: Cause.Cause<unknown>): void => {
  const refused =
    !Cause.hasDies(cause) &&
    !Cause.hasInterrupts(cause) &&
    Option.exists(Cause.findErrorOption(cause), (failure) =>
      Predicate.isTagged(failure, "ValidationFailed")
    );
  entry.feedback = refused ? "failed" : "uncertain";
  entry.wanted = Option.none();
};
const write = Effect.fnUntraced(function* (owner: Owner, command: Command) {
  const client = yield* owner.client;
  switch (command._tag) {
    case "Create":
      return (yield* client.ingestion.applyReviewEdit({ payload: command })).data;
    case "SaveDraft":
      return (yield* client.ingestion.applyReviewEdit({ payload: command })).data;
    case "Skip":
      return (yield* client.ingestion.applyReviewEdit({ payload: command })).data;
    case "Restore":
      return (yield* client.ingestion.applyReviewEdit({ payload: command })).data;
  }
});
const automaticReady = (entry: Entry, version: number): boolean =>
  version === entry.version && !entry.acting && now() >= entry.nextAutosaveAt;
const flush = (owner: Owner, entry: Entry, automatic = Option.none<number>()): Work =>
  entry.permit.withPermit(
    Effect.suspend(() =>
      Option.exists(automatic, (version) => !automaticReady(entry, version))
        ? Effect.void
        : Effect.gen(function* () {
            while (current(owner, entry) && !blocked(entry) && Option.isSome(entry.wanted)) {
              const draft = entry.wanted.value;
              entry.wanted = Option.none();
              entry.nextAutosaveAt = now() + autosaveIntervalMilliseconds;
              entry.feedback = "saving";
              notify(owner);
              const result = yield* Effect.exit(
                write(owner, {
                  _tag: "SaveDraft",
                  id: entry.detail.item.id,
                  revision: entry.detail.revision,
                  draft,
                })
              );
              if (!current(owner, entry)) return;
              if (result._tag === "Failure") reject(entry, result.cause);
              else acceptDraft(entry, result.value, draft);
              notify(owner);
              if (!blocked(entry)) {
                yield* invalidateItems({ ids: [entry.detail.item.id], countsChanged: false });
              }
              if (Option.isSome(automatic)) return;
            }
          })
    )
  );
const sameDraft = Schema.toEquivalence(ReviewDraft);
const acceptDraft = (entry: Entry, items: ReadonlyArray<Detail>, draft: Draft): void => {
  const latest = items[0];
  if (latest === undefined || !acceptedResults(items, [entry.detail.item], "pending") || !Option.exists(latest.draft, saved => sameDraft(saved, draft))) {
    entry.feedback = "uncertain";
    entry.wanted = Option.none();
    entry.version += 1;
    return;
  }
  entry.detail = { ...latest, item: { ...latest.item, expiresAt: entry.detail.item.expiresAt } };
  entry.feedback = Option.isSome(entry.wanted) ? "unsaved" : "saved";
};
const complete = (owner: Owner, items: ReadonlyArray<Detail>, skipped: boolean): void => {
  for (const detail of items) {
    const entry = makeEntry(detail);
    replaceEntry(owner, entry);
  }
  owner.completed = Option.some({ ids: items.map((detail) => detail.item.id) });
  if (owner.phase === "idle") {
    owner.feedback = skipped ? `${items.length} elementos omitidos.` : "Cambio guardado.";
  }
  if (skipped) owner.undo = items.map((detail) => detail.item);
  notify(owner);
  if (items.some((detail) => detail.item.status === "created")) {
    run(owner, Effect.sync(owner.created).pipe(Effect.catchDefect(() => Effect.void)));
  }
};
const decide = (owner: Owner, detail: Detail, kind: "Create" | "Skip"): void => {
  if (!owner.active || editorState(owner, detail).locked) return;
  const entry = retain(owner, detail);
  if (!current(owner, entry) || entry.detail.item.status !== "pending") return;
  const selected = { ...entry.detail.item, expiresAt: originalItem(owner, detail.item).expiresAt };
  entry.acting = true;
  notify(owner);
  run(
    owner,
    Effect.gen(function* () {
      yield* flush(owner, entry);
      if (!decisionCurrent(owner, entry, selected)) {
        return finishActing(owner, entry);
      }
      const acknowledged = { ...selected, revision: entry.detail.revision };
      const command =
        kind === "Create"
          ? creation({ detail: entry.detail, draft: entry.draft })
          : Option.some<Command>({
              _tag: "Skip",
              items: [{ id: detail.item.id, revision: entry.detail.revision }],
            });
      if (Option.isNone(command)) return finishActing(owner, entry);
      const result = yield* Effect.exit(write(owner, command.value));
      if (!decisionRetained(owner, entry, selected)) return;
      if (result._tag === "Failure") {
        reject(entry, result.cause);
        finishActing(owner, entry);
      } else if (!decisionAccepted(owner, { results: result.value, acknowledged, kind })) {
        entry.feedback = "uncertain";
        finishActing(owner, entry);
      } else {
        complete(owner, result.value, kind === "Skip");
        yield* invalidateItems({ ids: [entry.detail.item.id], countsChanged: true });
      }
    })
  );
};
const finishActing = (owner: Owner, entry: Entry): void => {
  entry.acting = false;
  notify(owner);
};
const decisionAccepted = (
  owner: Owner,
  {
    results,
    acknowledged,
    kind,
  }: Readonly<{
    results: ReadonlyArray<Detail>;
    acknowledged: Item;
    kind: "Create" | "Skip";
  }>
): boolean =>
  acceptedResults(results, [acknowledged], kind === "Create" ? "created" : "skipped") &&
  results.every((detail) => observedCurrent(owner, detail.item));
const decisionRetained = (owner: Owner, entry: Entry, selected: Item): boolean =>
  current(owner, entry) && !itemExpired(selected);
const decisionCurrent = (owner: Owner, entry: Entry, selected: Item): boolean =>
  decisionRetained(owner, entry, selected) &&
  !blocked(entry) &&
  observedCurrent(owner, { ...selected, revision: entry.detail.revision });
type Selected = Readonly<{ item: Item; entry: Option.Option<Entry> }>;
type Acknowledged = Readonly<{ selected: Selected; item: Item }>;
type BulkIntention = "Skip" | "Restore" | "Undo";
const bulk = (owner: Owner, items: ReadonlyArray<Item>, intention: BulkIntention): void => {
  if (!owner.active || owner.phase !== "idle" || items.length === 0) return;
  owner.phase = "writing";
  const selected = items.map((item): Selected => ({
    item: retainExpiry(owner, item),
    entry: Option.fromUndefinedOr(owner.entries.get(item.id)),
  }));
  const generation = owner.generation;
  notify(owner);
  if (!validSelection(selected, intention)) return failBulk(owner);
  run(owner, commitBulk(owner, { selected, intention, generation }));
};
const validSelection = (selected: ReadonlyArray<Selected>, intention: BulkIntention): boolean =>
  Option.isSome(
    Schema.decodeUnknownOption(ReviewCommand)({
      _tag: intention === "Skip" ? "Skip" : "Restore",
      items: selected.map(({ item }) => ({ id: item.id, revision: item.revision })),
    })
  ) &&
  new Set(selected.map(({ item }) => item.id)).size === selected.length &&
  selected.every(({ item }) => item.status === (intention === "Skip" ? "pending" : "skipped"));
const commitBulk = (
  owner: Owner,
  {
    selected,
    intention,
    generation,
  }: Readonly<{
    selected: ReadonlyArray<Selected>;
    intention: BulkIntention;
    generation: number;
  }>
): Work => {
  const kind = intention === "Skip" ? "Skip" : "Restore";
  const status = intention === "Skip" ? "skipped" : "pending";
  return Effect.gen(function* () {
    const saved = yield* Effect.forEach(selected, (member) => flushItem(owner, member, intention));
    if (!liveGeneration(owner, generation)) return;
    const ready = Option.all(saved);
    if (Option.isNone(ready)) return failBulk(owner);
    const acknowledged = ready.value.map(({ item }) => item);
    const first = acknowledged[0];
    if (first === undefined || !ready.value.every((item) => selectedCurrent(owner, item))) {
      return failBulk(owner);
    }
    const result = yield* Effect.exit(
      write(owner, {
        _tag: kind,
        items: [first, ...acknowledged.slice(1)],
      })
    );
    if (!liveGeneration(owner, generation)) return;
    if (
      result._tag === "Failure" ||
      !bulkAccepted(owner, ready.value, { results: result.value, status })
    ) {
      return failBulk(owner);
    }
    owner.phase = "idle";
    complete(owner, result.value, intention === "Skip");
    yield* invalidateItems({ ids: selected.map(({ item }) => item.id), countsChanged: true });
  });
};
const bulkAccepted = (
  owner: Owner,
  acknowledged: ReadonlyArray<Acknowledged>,
  { results, status }: Readonly<{ results: ReadonlyArray<Detail>; status: Item["status"] }>
): boolean =>
  acknowledged.every((item) => selectedRetained(owner, item)) &&
  results.every((detail) => observedCurrent(owner, detail.item)) &&
  acceptedResults(
    results,
    acknowledged.map(({ item }) => item),
    status
  );
const selectedCurrent = (owner: Owner, acknowledged: Acknowledged): boolean =>
  observedCurrent(owner, acknowledged.item) && selectedRetained(owner, acknowledged);
const selectedRetained = (owner: Owner, acknowledged: Acknowledged): boolean => {
  const { selected, item } = acknowledged;
  if (itemExpired(selected.item)) return false;
  const entry = owner.entries.get(selected.item.id);
  if (Option.isNone(selected.entry)) return entry === undefined;
  return entry === selected.entry.value && retainedCurrent(owner, entry, item);
};
const retainedCurrent = (owner: Owner, entry: Entry, item: Item): boolean =>
  current(owner, entry) &&
  !entry.acting &&
  !blocked(entry) &&
  entry.detail.revision === item.revision &&
  entry.detail.item.status === item.status;
const flushItem = (
  owner: Owner,
  selected: Selected,
  intention: BulkIntention
): Effect.Effect<Option.Option<Acknowledged>, never, Reactivity.Reactivity> =>
  Effect.gen(function* () {
    const { item } = selected;
    if (itemExpired(item)) return Option.none();
    if (Option.isNone(selected.entry)) return Option.some({ selected, item });
    const entry = selected.entry.value;
    if (entry.acting || entry.detail.item.status !== item.status) return Option.none();
    if (intention !== "Undo") yield* flush(owner, entry);
    const acknowledged = {
      selected,
      item: intention === "Undo" ? item : { ...item, revision: entry.detail.revision },
    };
    return selectedCurrent(owner, acknowledged) ? Option.some(acknowledged) : Option.none();
  });
const observedCurrent = (owner: Owner, acknowledged: Item): boolean => {
  const result = owner.get.once(owner.query);
  if (!AsyncResult.isSuccess(result) || result.waiting) return true;
  return result.value.data.items.every(
    (item) =>
      item.id !== acknowledged.id ||
      item.revision < acknowledged.revision ||
      (item.revision === acknowledged.revision &&
        item.status === acknowledged.status &&
        DateTime.toEpochMillis(item.expiresAt) === DateTime.toEpochMillis(acknowledged.expiresAt))
  );
};
const receiptMatches = (receipt: Item, item: Item): boolean =>
  receipt.id === item.id &&
  receipt.revision === item.revision &&
  item.status === "skipped" &&
  DateTime.toEpochMillis(receipt.expiresAt) === DateTime.toEpochMillis(item.expiresAt);
const pruneUndo = (owner: Owner, observed: ReadonlyArray<Item>): void => {
  owner.undo = owner.undo.filter(
    (receipt) =>
      !itemExpired(receipt) &&
      observed.every(
        (item) =>
          item.id !== receipt.id ||
          item.revision < receipt.revision ||
          receiptMatches(receipt, item)
      )
  );
};
const eligibleUndo = (owner: Owner): ReadonlyArray<Item> =>
  owner.undo.filter((receipt) => {
    const entry = owner.entries.get(receipt.id);
    return (
      !itemExpired(receipt) &&
      entry !== undefined &&
      current(owner, entry) &&
      !blocked(entry) &&
      !entry.acting &&
      receiptMatches(receipt, entry.detail.item)
    );
  });
const failBulk = (owner: Owner): void => {
  owner.phase = "uncertain";
  owner.feedback = "No pudimos confirmar el cambio. Actualiza antes de continuar.";
  notify(owner);
};
const recoverItem = (owner: Owner, detail: Detail): void => {
  if (!owner.active || owner.phase !== "idle") return;
  const entry = retain(owner, detail);
  if (entry.recovering || entry.acting || !current(owner, entry)) return;
  entry.recovering = true;
  entry.wanted = Option.none();
  entry.version += 1;
  notify(owner);
  run(
    owner,
    entry.permit.withPermit(
      Effect.gen(function* () {
        if (!current(owner, entry)) return;
        const result = yield* Effect.exit(
          owner.client.pipe(
            Effect.flatMap((client) =>
              client.ingestion.getReviewItem({ params: { id: detail.item.id } })
            )
          )
        );
        if (!current(owner, entry)) return;
        if (
          result._tag === "Failure" ||
          result.value.data.item.id !== detail.item.id ||
          result.value.data.revision < entry.detail.revision ||
          result.value.data.item.revision !== result.value.data.revision ||
          DateTime.toEpochMillis(result.value.data.item.expiresAt) !==
            DateTime.toEpochMillis(entry.detail.item.expiresAt)
        ) {
          entry.recovering = false;
          entry.feedback = "uncertain";
        } else {
          const replacement = makeEntry(result.value.data);
          replaceEntry(owner, replacement);
          yield* invalidateItems({ ids: [detail.item.id], countsChanged: true });
        }
        notify(owner);
      })
    )
  );
};
const recoverWorkspace = (owner: Owner): void => {
  if (!owner.active || owner.phase === "writing" || owner.phase === "recovering") return;
  const previousPhase = owner.phase;
  owner.phase = "recovering";
  notify(owner);
  const generation = owner.generation;
  const previous = owner.get.once(owner.query);
  owner.get.refresh(owner.query);
  run(
    owner,
    Effect.gen(function* () {
      const succeeded = yield* workspaceRecovered(owner, previous);
      if (!liveGeneration(owner, generation)) return;
      if (succeeded) {
        owner.phase = "idle";
        owner.feedback = "";
        yield* Reactivity.invalidate([reviewCountKey, reviewContextKey]);
      } else owner.phase = previousPhase;
      notify(owner);
    })
  );
};

const liveGeneration = (owner: Owner, generation: number): boolean =>
  owner.active && owner.generation === generation;
const acceptedResults = (
  results: ReadonlyArray<Detail>,
  items: ReadonlyArray<Item>,
  status: Item["status"]
): boolean => {
  const expected = new Map(items.map((item) => [item.id, item]));
  return (
    expected.size === items.length &&
    results.length === items.length &&
    results.every((detail) => {
      const item = expected.get(detail.item.id);
      if (item === undefined) return false;
      expected.delete(detail.item.id);
      return (
        detail.item.status === status &&
        detail.revision === item.revision + 1 &&
        detail.item.revision === detail.revision &&
        DateTime.toEpochMillis(detail.item.expiresAt) === DateTime.toEpochMillis(item.expiresAt)
      );
    })
  );
};

const workspaceRecovered = (
  owner: Owner,
  previous: ReturnType<ReviewWorkspaceQuery["read"]>
): Effect.Effect<boolean> =>
  owner.get.resultOnce(owner.query, { suspendOnWaiting: true }).pipe(
    Effect.matchCause({
      onSuccess: () => owner.get.once(owner.query) !== previous,
      onFailure: () => false,
    })
  );

const itemExpired = (item: Item): boolean => now() >= DateTime.toEpochMillis(item.expiresAt);
