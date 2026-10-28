import {
  Cause,
  type Context,
  DateTime,
  Deferred,
  Effect,
  Option,
  Predicate,
  Semaphore,
} from "effect";
import { type AsyncResult, Atom, Reactivity } from "effect/reactivity";
import type { CanonicalSuccess, FidyClient } from "@/transport/client";
import { type Command, type Detail, type Draft, type Item, creation, emptyDraft } from "./model";

type Feedback = "saved" | "saving" | "unsaved" | "failed" | "uncertain";
type Completion = Readonly<{ ids: ReadonlyArray<Item["id"]> }>;
export type ReviewEditorState = Readonly<{
  detail: Detail;
  draft: Draft;
  feedback: Feedback;
  locked: boolean;
  canCreate: boolean;
  recovering: boolean;
}>;
export type ReviewDecisions = Readonly<{
  locked: boolean;
  feedback: string;
  undoCount: number;
  completed: Option.Option<Completion>;
  editor: (detail: Detail) => ReviewEditorState;
  change: (detail: Detail, draft: Draft) => void;
  decide: (detail: Detail, kind: "Create" | "Skip") => void;
  bulk: (restore: boolean, items: ReadonlyArray<Item>) => void;
  undoSkip: () => void;
  recoverItem: (detail: Detail) => void;
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
  active: boolean;
  generation: number;
  stopped: Deferred.Deferred<void>;
  phase: "idle" | "writing" | "uncertain" | "recovering";
  feedback: string;
  undo: ReadonlyArray<Detail>;
  completed: Option.Option<Completion>;
};
const autosaveMilliseconds = 650;
const maximumTimerMilliseconds = 2_147_483_647;
const now = (): number => DateTime.toEpochMillis(DateTime.nowUnsafe());
const draftFor = (detail: Detail): Draft =>
  Option.getOrElse(
    Option.orElse(detail.draft, () => detail.suggestions),
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
      active: false,
      generation: 0,
      stopped: Deferred.makeUnsafe<void>(),
      phase: "idle",
      feedback: "",
      undo: [],
      completed: Option.none(),
    };
    get.addFinalizer(() => dispose(owner));
    return present(owner);
  });
};
const present = (owner: Owner): ReviewDecisions => ({
  locked: owner.phase !== "idle",
  feedback: owner.feedback,
  undoCount: owner.undo.length,
  completed: owner.completed,
  editor: (detail) => editorState(owner, detail),
  change: (detail, draft) => changeDraft(owner, detail, draft),
  decide: (detail, kind) => decide(owner, detail, kind),
  bulk: (restore, items) => bulk(owner, restore, items),
  undoSkip: () => {
    if (owner.phase !== "idle") return;
    const items = owner.undo.map((detail) => ({ ...detail.item, revision: detail.revision }));
    owner.undo = [];
    bulk(owner, true, items);
  },
  recoverItem: (detail) => recoverItem(owner, detail),
  recover: () => recoverWorkspace(owner),
  mount: () => {
    owner.stopped = Deferred.makeUnsafe<void>();
    owner.active = true;
    return () => dispose(owner);
  },
});
const selectedEntry = (owner: Owner, detail: Detail): Entry => {
  const entry = owner.entries.get(detail.item.id);
  if (entry === undefined) return makeEntry(detail);
  const newer = detail.revision > entry.detail.revision;
  return newer && entry.feedback === "saved" && !entry.acting ? makeEntry(detail) : entry;
};
const editorState = (owner: Owner, detail: Detail): ReviewEditorState => {
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
      now() >= DateTime.toEpochMillis(detail.item.expiresAt),
    canCreate: Option.isSome(creation({ detail: entry.detail, draft: entry.draft })),
    recovering: entry.recovering,
  };
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
    owner.undo = owner.undo.filter((detail) => detail.item.id !== entry.detail.item.id);
    notify(owner);
  }).pipe(Effect.raceFirst(Deferred.await(entry.retired)));
const replaceEntry = (owner: Owner, entry: Entry): void => {
  const previous = owner.entries.get(entry.detail.item.id);
  if (previous !== undefined) Deferred.doneUnsafe(previous.retired, Effect.void);
  owner.entries.set(entry.detail.item.id, entry);
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
    Effect.sleep(autosaveMilliseconds).pipe(
      Effect.andThen(
        Effect.suspend(() => (version === entry.version ? flush(owner, entry) : Effect.void))
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
const flush = (owner: Owner, entry: Entry): Work =>
  entry.permit.withPermit(
    Effect.gen(function* () {
      while (current(owner, entry) && !blocked(entry) && Option.isSome(entry.wanted)) {
        const draft = entry.wanted.value;
        entry.wanted = Option.none();
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
        else acceptDraft(entry, result.value);
        notify(owner);
        if (result._tag === "Success") yield* Reactivity.invalidate(["ingestion-review"]);
      }
    })
  );
const acceptDraft = (entry: Entry, items: ReadonlyArray<Detail>): void => {
  const latest = items.find((detail) => detail.item.id === entry.detail.item.id);
  if (latest === undefined) {
    entry.feedback = "uncertain";
    return;
  }
  entry.detail = latest;
  entry.feedback = Option.isSome(entry.wanted) ? "unsaved" : "saved";
};
const complete = (owner: Owner, items: ReadonlyArray<Detail>, skipped: boolean): void => {
  for (const detail of items) {
    const entry = makeEntry(detail);
    replaceEntry(owner, entry);
  }
  if (items.some((detail) => detail.item.status === "created")) owner.created();
  owner.completed = Option.some({ ids: items.map((detail) => detail.item.id) });
  owner.feedback = skipped ? `${items.length} elementos omitidos.` : "Cambio guardado.";
  if (skipped) owner.undo = items;
  notify(owner);
};
const decide = (owner: Owner, detail: Detail, kind: "Create" | "Skip"): void => {
  if (!owner.active || editorState(owner, detail).locked) return;
  const entry = retain(owner, detail);
  if (!current(owner, entry) || entry.detail.item.status !== "pending") return;
  entry.acting = true;
  notify(owner);
  run(
    owner,
    Effect.gen(function* () {
      yield* flush(owner, entry);
      if (!current(owner, entry) || blocked(entry)) return finishActing(owner, entry);
      const command =
        kind === "Create"
          ? creation({ detail: entry.detail, draft: entry.draft })
          : Option.some<Command>({
              _tag: "Skip",
              items: [{ id: detail.item.id, revision: entry.detail.revision }],
            });
      if (Option.isNone(command)) return finishActing(owner, entry);
      const result = yield* Effect.exit(write(owner, command.value));
      if (!current(owner, entry)) return;
      if (result._tag === "Failure") {
        reject(entry, result.cause);
        finishActing(owner, entry);
      } else if (!sameItems(result.value, [detail.item])) {
        entry.feedback = "uncertain";
        finishActing(owner, entry);
      } else {
        complete(owner, result.value, kind === "Skip");
        yield* Reactivity.invalidate(["ingestion-review"]);
      }
    })
  );
};
const finishActing = (owner: Owner, entry: Entry): void => {
  entry.acting = false;
  notify(owner);
};
const bulk = (owner: Owner, restore: boolean, items: ReadonlyArray<Item>): void => {
  if (!owner.active || owner.phase !== "idle" || items.length === 0) return;
  owner.phase = "writing";
  const generation = owner.generation;
  notify(owner);
  run(
    owner,
    Effect.gen(function* () {
      const saved = yield* Effect.forEach(items, (item) => flushItem(owner, item));
      if (!liveGeneration(owner, generation)) return;
      const ready = Option.filter(Option.all(saved), () => !items.some(itemExpired));
      if (Option.isNone(ready)) return failBulk(owner);
      const first = ready.value[0];
      if (first === undefined) return failBulk(owner);
      const result = yield* Effect.exit(
        write(owner, {
          _tag: restore ? "Restore" : "Skip",
          items: [first, ...ready.value.slice(1)],
        })
      );
      if (!liveGeneration(owner, generation)) return;
      if (result._tag === "Failure") return failBulk(owner);
      if (!sameItems(result.value, items)) return failBulk(owner);
      owner.phase = "idle";
      complete(owner, result.value, !restore);
      yield* Reactivity.invalidate(["ingestion-review"]);
    })
  );
};
const flushItem = (
  owner: Owner,
  item: Item
): Effect.Effect<
  Option.Option<{ id: Item["id"]; revision: number }>,
  never,
  Reactivity.Reactivity
> =>
  Effect.gen(function* () {
    if (now() >= DateTime.toEpochMillis(item.expiresAt)) return Option.none();
    const entry = owner.entries.get(item.id);
    if (entry === undefined) return Option.some({ id: item.id, revision: item.revision });
    if (entry.acting) return Option.none();
    yield* flush(owner, entry);
    return current(owner, entry) && !blocked(entry)
      ? Option.some({ id: item.id, revision: entry.detail.revision })
      : Option.none();
  });
const failBulk = (owner: Owner): void => {
  owner.phase = "uncertain";
  owner.feedback = "No pudimos confirmar el cambio. Actualiza antes de continuar.";
  notify(owner);
};
const recoverItem = (owner: Owner, detail: Detail): void => {
  if (!owner.active) return;
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
        const result = yield* Effect.exit(
          owner.client.pipe(
            Effect.flatMap((client) =>
              client.ingestion.getReviewItem({ params: { id: detail.item.id } })
            )
          )
        );
        if (!current(owner, entry)) return;
        if (result._tag === "Failure") {
          entry.recovering = false;
          entry.feedback = "uncertain";
        } else {
          const replacement = makeEntry(result.value.data);
          replaceEntry(owner, replacement);
          yield* Reactivity.invalidate(["ingestion-review"]);
        }
        notify(owner);
      })
    )
  );
};
const recoverWorkspace = (owner: Owner): void => {
  if (!owner.active || owner.phase === "writing" || owner.phase === "recovering") return;
  owner.phase = "recovering";
  notify(owner);
  const generation = owner.generation;
  owner.get.refresh(owner.query);
  run(
    owner,
    Effect.gen(function* () {
      const succeeded = yield* workspaceRecovered(owner);
      if (!liveGeneration(owner, generation)) return;
      if (succeeded) {
        owner.phase = "idle";
        owner.feedback = "";
      } else failBulk(owner);
      notify(owner);
    })
  );
};

const liveGeneration = (owner: Owner, generation: number): boolean =>
  owner.active && owner.generation === generation;
const sameItems = (results: ReadonlyArray<Detail>, items: ReadonlyArray<Item>): boolean => {
  const expected = new Set(items.map((item) => item.id));
  return (
    results.length === expected.size && results.every((detail) => expected.delete(detail.item.id))
  );
};

const workspaceRecovered = (owner: Owner): Effect.Effect<boolean> =>
  owner.get
    .resultOnce(owner.query, { suspendOnWaiting: true })
    .pipe(Effect.matchCause({ onSuccess: () => true, onFailure: () => false }));

const itemExpired = (item: Item): boolean => now() >= DateTime.toEpochMillis(item.expiresAt);
