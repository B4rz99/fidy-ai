import { Clock, DateTime, Deferred, Effect, Fiber, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, expect, vi } from "vitest";
import { it } from "@effect/vitest";
import { ReviewCommand, makeFidyClient } from "@/transport/client";
import { type ReviewDecisions, makeReviewDecisions } from "./decisions";
import { type Detail, type Draft, emptyDraft } from "./model";

const firstId = "24000000-0000-4000-8000-000000001350";
const secondId = "24000000-0000-4000-8000-000000001351";
type FixtureItem = {
  id: string;
  source: string;
  timeZone: string;
  reason: string;
  status: string;
  revision: number;
  createdAt: string;
  expiresAt: string;
};
const fixtureItem = (id = firstId): FixtureItem => ({
  id,
  source: "statement",
  timeZone: "America/Bogota",
  reason: "ambiguous-currency",
  status: "pending",
  revision: 0,
  createdAt: "2026-10-15T12:00:00Z",
  expiresAt: "2027-01-13T12:00:00Z",
});
type Saved = { item: ReturnType<typeof fixtureItem>; revision: number; draft: unknown };
const resources: Array<() => void> = [];
afterEach(() => {
  resources
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  vi.useRealTimers();
});
type Fixture = {
  view: () => ReviewDecisions;
  detail: Detail;
  entries: Map<string, Saved>;
  sent: Array<ReviewCommand>;
  reads: Array<string>;
  remount: () => void;
  dispose: () => void;
  failWrite: (value: boolean) => void;
  failRead: (value: boolean) => void;
  missingResult: () => void;
  duplicateResult: () => void;
  delay: (value: number) => void;
  holdWrite: () => () => void;
};
const fixture = Effect.fnUntraced(function* (firstExpiry: Option.Option<number> = Option.none()) {
  vi.useFakeTimers();
  vi.setSystemTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-28T00:00:00Z")));
  const originalNow = yield* Clock.currentTimeMillis;
  const entries = new Map<string, Saved>(
    [firstId, secondId].map((id) => {
      const item = fixtureItem(id);
      if (id === firstId && Option.isSome(firstExpiry)) {
        item.expiresAt = DateTime.formatIso(DateTime.makeUnsafe(originalNow + firstExpiry.value));
      }
      return [id, { item, revision: 0, draft: undefined }];
    })
  );
  const sent: Array<ReviewCommand> = [];
  const reads: Array<string> = [];
  let failWrite = false;
  let failRead = false;
  let missingResult = false;
  let duplicateResult = false;
  let delay = 0;
  let writeGate: Effect.Effect<void> = Effect.void;
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const path = new URL(request.url).pathname;
      let data: unknown;
      if (request.method === "POST") {
        const command = yield* Schema.decodeEffect(Schema.fromJsonString(ReviewCommand))(
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : ""
        );
        sent.push(command);
        yield* writeGate;
        yield* Effect.sleep(delay);
        data = fixtureResult(applyFixture(entries, command), { missingResult, duplicateResult });
        if (failWrite) {
          return HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 }));
        }
      } else {
        reads.push(path);
        if (failRead) {
          return HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 }));
        }
        data = path.endsWith("review-workspace")
          ? {
              pendingCount: entries.size,
              total: entries.size,
              items: [...entries.values()].map((entry) => entry.item),
            }
          : entries.get(path.split("/").at(-1) ?? "");
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ data, next: [] }),
          {
            headers: { "content-type": "application/json" },
          }
        )
      );
    }).pipe(Effect.orDie)
  );
  const client = makeFidyClient({
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(HttpClient.HttpClient, http),
  });
  const registry = AtomRegistry.make();
  resources.push(() => registry.dispose());
  const query = client.query("ingestion", "getReviewWorkspace", {
    query: { status: Option.some("pending" as const), offset: Option.none() },
  });
  const atom = makeReviewDecisions({ client, query, created: () => {} });
  const unmount = registry.mount(atom);
  resources.push(unmount);
  const dispose = registry.get(atom).mount();
  resources.push(dispose);
  const detailQuery = client.query("ingestion", "getReviewItem", {
    params: { id: yield* Schema.decodeEffect(ReviewCommand.members[0].fields.id)(firstId) },
  });
  const detailFiber = yield* Effect.forkChild(AtomRegistry.getResult(registry, detailQuery));
  yield* advance(0);
  const detail = (yield* Fiber.join(detailFiber)).data;
  const fixture: Fixture = {
    view: (): ReviewDecisions => registry.get(atom),
    detail,
    entries,
    sent,
    reads,
    remount: () => {
      resources.push(registry.get(atom).mount());
    },
    dispose,
    failWrite: (value: boolean): void => {
      failWrite = value;
    },
    failRead: (value: boolean): void => {
      failRead = value;
    },
    missingResult: (): void => {
      missingResult = true;
    },
    duplicateResult: (): void => {
      duplicateResult = true;
    },
    holdWrite: () => {
      const pending = Deferred.makeUnsafe<void>();
      writeGate = Deferred.await(pending);
      return () => {
        writeGate = Effect.void;
        Deferred.doneUnsafe(pending, Effect.void);
      };
    },
    delay: (value: number): void => {
      delay = value;
    },
  };
  return fixture;
});
const advance = Effect.fnUntraced(function* (milliseconds: number) {
  yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(milliseconds));
});
const fixtureResult = (
  data: ReadonlyArray<Saved>,
  mode: Readonly<{ missingResult: boolean; duplicateResult: boolean }>
): ReadonlyArray<Saved> => {
  if (mode.missingResult) return [];
  return mode.duplicateResult ? [...data, ...data] : data;
};
const applyFixture = (
  entries: Map<string, Saved>,
  command: ReviewCommand
): ReadonlyArray<Saved> => {
  const refs =
    "items" in command ? command.items : [{ id: command.id, revision: command.revision }];
  return refs.map((reference) => {
    const entry = entries.get(reference.id);
    if (entry === undefined || reference.revision !== entry.revision) {
      throw new Error("Stale fixture revision");
    }
    entry.revision += 1;
    entry.item = { ...entry.item, revision: entry.revision };
    if (command._tag === "SaveDraft") {
      const encoded = Schema.encodeSync(ReviewCommand)(command);
      if (encoded._tag === "SaveDraft") entry.draft = encoded.draft;
    }
    if (command._tag === "Skip") entry.item.status = "skipped";
    if (command._tag === "Restore") entry.item.status = "pending";
    return { ...entry };
  });
};
const edit = (amount: string): Draft => ({ ...emptyDraft(), amount });

it.live(
  "flushes a changed draft before bulk Skip and restores using its acknowledged revision",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      test.view().editor(test.detail).change(edit("98765"));
      test.view().bulk(false, [test.detail.item]);
      yield* advance(0);
      expect(test.sent.map((command) => command._tag)).toEqual(["SaveDraft", "Skip"]);
      expect(test.sent[1]).toMatchObject({ items: [{ id: firstId, revision: 1 }] });
      expect(test.view().undoCount).toBe(1);
      test.view().undoSkip();
      yield* advance(0);
      expect(test.sent[2]).toMatchObject({
        _tag: "Restore",
        items: [{ id: firstId, revision: 2 }],
      });
      expect(test.entries.get(firstId)?.draft).toMatchObject({ amount: "98765" });
    })
);

it.live("saves promptly while spacing automatic writes and retaining the latest draft", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    test.view().editor(test.detail).change(edit("100"));
    yield* advance(250);
    expect(test.sent).toHaveLength(1);
    test.view().editor(test.detail).change(edit("200"));
    yield* advance(250);
    expect(test.sent).toHaveLength(1);
    test.view().editor(test.detail).change(edit("300"));
    yield* advance(750);
    expect(test.sent).toHaveLength(2);
    expect(test.sent[1]).toMatchObject({ revision: 1, draft: { amount: "300" } });
    expect(test.view().editor(test.detail).feedback).toBe("saved");
  })
);

it.live("serializes new draft changes behind an in-flight save before deciding", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    test.delay(100);
    test.view().editor(test.detail).change(edit("100"));
    yield* advance(250);
    test.view().editor(test.detail).change(edit("200"));
    test.view().decide(test.detail, "Skip");
    yield* advance(400);
    expect(test.sent.map((command) => command._tag)).toEqual(["SaveDraft", "SaveDraft", "Skip"]);
    expect(test.sent[1]).toMatchObject({ revision: 1, draft: { amount: "200" } });
    expect(test.sent[2]).toMatchObject({ items: [{ revision: 2 }] });
  })
);

it.live(
  "requires a successful explicit item reread after a lost acknowledgement without replaying the write",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      test.failWrite(true);
      test.view().editor(test.detail).change(edit("42000"));
      yield* advance(650);
      expect(test.view().editor(test.detail).feedback).toBe("uncertain");
      test.view().decide(test.detail, "Skip");
      test.failRead(true);
      test.view().editor(test.detail).recover();
      yield* advance(2000);
      expect(test.view().editor(test.detail).locked).toBe(true);
      test.failRead(false);
      test.view().editor(test.detail).recover();
      yield* advance(0);
      expect(test.view().editor(test.detail)).toMatchObject({
        locked: false,
        draft: { amount: "42000" },
      });
      expect(test.sent).toHaveLength(1);
    })
);

it.live("a failed workspace refresh does not invent an uncertain decision", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    test.failRead(true);
    test.view().recover();
    yield* advance(2000);
    expect(test.view()).toMatchObject({ locked: false, feedback: "", undoCount: 0 });
    expect(test.sent).toHaveLength(0);
    test.failRead(false);
    test.view().recover();
    yield* advance(0);
    expect(test.view()).toMatchObject({ locked: false, feedback: "" });
  })
);

it.live("keeps a failed bulk decision locked until its explicit workspace reread succeeds", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    test.failWrite(true);
    test.view().bulk(false, [test.detail.item]);
    yield* advance(0);
    expect(test.view().locked).toBe(true);
    test.failRead(true);
    test.view().recover();
    yield* advance(2000);
    expect(test.view().locked).toBe(true);
    test.failRead(false);
    test.view().recover();
    yield* advance(0);
    expect(test.view().locked).toBe(false);
    expect(test.sent).toHaveLength(1);
  })
);

it.live(
  "cancels unsent saves on disposal and rejects events retained by a disposed presentation",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      const retained = test.view();
      retained.editor(test.detail).change(edit("100"));
      test.dispose();
      retained.editor(test.detail).change(edit("200"));
      retained.decide(test.detail, "Skip");
      yield* advance(1000);
      expect(test.sent).toHaveLength(0);
    })
);

it.live("disposal during a save prevents its queued decision and ignores a late result", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    test.delay(200);
    test.view().editor(test.detail).change(edit("100"));
    test.view().bulk(false, [test.detail.item]);
    yield* advance(0);
    expect(test.sent).toHaveLength(1);
    test.dispose();
    yield* advance(1000);
    expect(test.sent).toHaveLength(1);
    expect(Option.isNone(test.view().completed)).toBe(true);
  })
);

it.live("evidence expiry prevents a pending autosave from submitting", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    const detail: Detail = {
      ...test.detail,
      item: {
        ...test.detail.item,
        expiresAt: DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 100),
      },
    };
    test.view().editor(detail).change(edit("100"));
    yield* advance(1000);
    expect(test.sent).toHaveLength(0);
    expect(test.view().editor(detail).locked).toBe(true);
  })
);

it.live("an incomplete save acknowledgement blocks the following decision", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    test.missingResult();
    const release = test.holdWrite();
    test.view().editor(test.detail).change(edit("100"));
    yield* advance(250);
    test.view().editor(test.detail).change(edit("200"));
    release();
    yield* advance(0);
    expect(test.view().editor(test.detail)).toMatchObject({
      feedback: "uncertain",
      draft: { amount: "200" },
    });
    test.view().decide(test.detail, "Skip");
    yield* advance(2000);
    expect(test.sent).toHaveLength(1);
  })
);

it.live("keeps a failed item's lock local while allowing another item to save", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    test.failWrite(true);
    test.view().editor(test.detail).change(edit("100"));
    yield* advance(650);
    test.failWrite(false);
    const other: Detail = {
      ...test.detail,
      item: {
        ...test.detail.item,
        id: yield* Schema.decodeEffect(ReviewCommand.members[0].fields.id)(secondId),
      },
    };
    test.view().editor(other).change(edit("200"));
    yield* advance(650);
    expect(test.view().editor(test.detail).locked).toBe(true);
    expect(test.view().editor(other)).toMatchObject({ locked: false, feedback: "saved" });
    expect(test.sent).toHaveLength(2);
  })
);

it.live("accepts a newer canonical draft only while the local draft is clean", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    const newer: Detail = { ...test.detail, revision: 1, draft: Option.some(edit("900")) };
    expect(test.view().editor(newer).draft.amount).toBe("900");
    test.view().editor(test.detail).change(edit("100"));
    expect(test.view().editor(newer)).toMatchObject({
      locked: true,
      feedback: "failed",
      draft: { amount: "100" },
    });
    test.dispose();
  })
);

it.live("an unrelated individual completion cannot release an in-flight bulk lock", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    const other: Detail = {
      ...test.detail,
      item: {
        ...test.detail.item,
        id: yield* Schema.decodeEffect(ReviewCommand.members[0].fields.id)(secondId),
      },
    };
    test.delay(100);
    test.view().decide(test.detail, "Skip");
    yield* advance(0);
    test.delay(300);
    test.view().bulk(false, [other.item]);
    yield* advance(100);
    expect(test.view().locked).toBe(true);
    yield* advance(300);
    expect(test.view().locked).toBe(false);
  })
);

it.live("a workspace refresh cannot release a bulk decision still waiting for its response", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    test.delay(300);
    test.view().bulk(false, [test.detail.item]);
    yield* advance(0);
    test.view().recover();
    yield* advance(100);
    expect(test.view().locked).toBe(true);
    test.view().bulk(false, [test.detail.item]);
    yield* advance(300);
    expect(test.sent).toHaveLength(1);
    expect(test.view().locked).toBe(false);
  })
);

it.live("rechecks every selected item's expiry after waiting for other draft saves", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    const expiring = {
      ...test.detail.item,
      expiresAt: DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 100),
    };
    const other: Detail = {
      ...test.detail,
      item: {
        ...test.detail.item,
        id: yield* Schema.decodeEffect(ReviewCommand.members[0].fields.id)(secondId),
      },
    };
    test.delay(300);
    test.view().editor(other).change(edit("200"));
    test.view().bulk(false, [expiring, other.item]);
    yield* advance(400);
    expect(test.sent.map((command) => command._tag)).toEqual(["SaveDraft"]);
    expect(test.view().locked).toBe(true);
  })
);

it.live("opens canonical review suggestions as localized drafts without changing their Money", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    const detail = {
      ...test.detail,
      suggestions: Option.some({
        ...emptyDraft(),
        amount: "12.5",
        currency: Option.some("COP" as const),
      }),
    };
    expect(test.view().editor(detail).draft.amount).toBe("12,5");
  })
);

it.live("confirms localized review Money exactly and blocks invalid amounts", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    const draft = {
      ...emptyDraft(),
      amount: "12.500,50",
      currency: Option.some("COP" as const),
      direction: Option.some("outflow" as const),
      occurredAt: "2026-10-15T12:00:00Z",
    };
    for (const amount of ["", "0", "-12", "12.50", "12,501"]) {
      test
        .view()
        .editor(test.detail)
        .change({ ...draft, amount });
      expect(test.view().editor(test.detail).canCreate).toBe(false);
    }
    test.view().editor(test.detail).change(draft);
    expect(test.view().editor(test.detail).canCreate).toBe(true);
    test.view().decide(test.detail, "Create");
    yield* advance(0);
    const command = test.sent.find((sent) => sent._tag === "Create");
    const encoded =
      command === undefined ? undefined : yield* Schema.encodeEffect(ReviewCommand)(command);
    expect(encoded).toMatchObject({
      _tag: "Create",
      extraction: { money: { amount: "12500.5", currency: "COP" } },
    });
  })
);

it.live("retires an obsolete autosave waiting for the item permit before a newer debounce", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    const release = test.holdWrite();
    test.view().editor(test.detail).change(edit("100"));
    yield* advance(250);
    test.view().editor(test.detail).change(edit("200"));
    yield* advance(1350);
    test.view().editor(test.detail).change(edit("300"));
    yield* advance(100);
    release();
    yield* advance(0);
    expect(test.sent).toHaveLength(1);
    expect(test.view().editor(test.detail)).toMatchObject({
      draft: { amount: "300" },
      feedback: "unsaved",
    });
    test.delay(0);
    yield* advance(100);
    expect(test.sent).toHaveLength(2);
    expect(test.sent[1]).toMatchObject({ revision: 1, draft: { amount: "300" } });
  })
);

it.live("keeps the first expiry after a canonical recovery returns a later deadline", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    const detail: Detail = {
      ...test.detail,
      item: {
        ...test.detail.item,
        expiresAt: DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 1000),
      },
    };
    test.view().editor(detail).recover();
    yield* advance(0);
    yield* advance(1100);
    expect(test.view().editor(test.detail).locked).toBe(true);
    test.view().editor(test.detail).change(edit("100"));
    test.view().decide(test.detail, "Skip");
    yield* advance(2000);
    expect(test.sent).toHaveLength(0);
  })
);

it.live(
  "refuses duplicate save acknowledgments and retains the displayed next draft until recovery",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      test.duplicateResult();
      test.delay(500);
      test.view().editor(test.detail).change(edit("100"));
      yield* advance(250);
      test.view().editor(test.detail).change(edit("200"));
      yield* advance(500);
      expect(test.view().editor(test.detail)).toMatchObject({
        locked: true,
        feedback: "uncertain",
        draft: { amount: "200" },
        detail: { revision: 0 },
      });
      test.view().decide(test.detail, "Skip");
      yield* advance(2000);
      expect(test.sent).toHaveLength(1);
      test.failRead(true);
      test.view().editor(test.detail).recover();
      yield* advance(2000);
      expect(test.view().editor(test.detail).locked).toBe(true);
      test.failRead(false);
      test.view().editor(test.detail).recover();
      yield* advance(0);
      expect(test.view().editor(test.detail)).toMatchObject({
        locked: false,
        feedback: "saved",
        draft: { amount: "100" },
        detail: { revision: 1 },
      });
      yield* advance(2000);
      expect(test.sent).toHaveLength(1);
    })
);

it.live("retired editor callbacks cannot edit or recover a remounted owner", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    const initialReads = test.reads.length;
    const retired = test.view().editor(test.detail);
    test.dispose();
    test.remount();
    retired.change(edit("100"));
    retired.recover();
    yield* advance(1000);
    expect(test.sent).toHaveLength(0);
    expect(test.reads).toHaveLength(initialReads);
    test.view().editor(test.detail).change(edit("200"));
    yield* advance(250);
    expect(test.sent).toHaveLength(1);
  })
);

it.live("recovery replaces a clean item without reactivating its old editor callbacks", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    const initialReads = test.reads.length;
    const previous = test.view().editor(test.detail);
    previous.recover();
    yield* advance(0);
    previous.change(edit("100"));
    previous.recover();
    yield* advance(1000);
    expect(test.sent).toHaveLength(0);
    expect(test.reads).toHaveLength(initialReads + 1);
    expect(test.view().editor(test.detail).locked).toBe(false);
  })
);

it.live(
  "expiry during a decision drain prevents the follow-on decision and late draft publication",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      const detail: Detail = {
        ...test.detail,
        item: {
          ...test.detail.item,
          expiresAt: DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 100),
        },
      };
      test.delay(500);
      test.view().editor(detail).change(edit("100"));
      test.view().decide(detail, "Skip");
      yield* advance(600);
      expect(test.sent.map((command) => command._tag)).toEqual(["SaveDraft"]);
      expect(Option.isNone(test.view().completed)).toBe(true);
      expect(test.view().editor(test.detail)).toMatchObject({
        locked: true,
        detail: { revision: 0 },
      });
    })
);

it.live("a recovery queued behind a save cannot read after original item expiry", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    const initialReads = test.reads.length;
    const detail: Detail = {
      ...test.detail,
      item: {
        ...test.detail.item,
        expiresAt: DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 500),
      },
    };
    test.delay(1000);
    test.view().editor(detail).change(edit("100"));
    yield* advance(250);
    test.view().editor(detail).recover();
    yield* advance(1500);
    expect(test.reads).toHaveLength(initialReads);
    expect(test.sent).toHaveLength(1);
    expect(test.view().editor(test.detail).locked).toBe(true);
  })
);

it.live("bulk admission closes recovery before its canonical decision completes", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    const initialReads = test.reads.length;
    const editor = test.view().editor(test.detail);
    const release = test.holdWrite();
    test.view().bulk(false, [test.detail.item]);
    yield* advance(0);
    editor.recover();
    yield* advance(0);
    expect(test.reads).toHaveLength(initialReads);
    release();
    yield* advance(0);
    expect(test.sent.map((command) => command._tag)).toEqual(["Skip"]);
    expect(test.view().locked).toBe(false);
  })
);

it.live("bulk Skip cannot revive a recovered item after its original expiry", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    const detail: Detail = {
      ...test.detail,
      item: {
        ...test.detail.item,
        expiresAt: DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 1000),
      },
    };
    test.view().editor(detail).recover();
    yield* advance(1100);
    test.view().bulk(false, [test.detail.item]);
    yield* advance(0);
    expect(test.sent).toHaveLength(0);
    expect(Option.isNone(test.view().completed)).toBe(true);
  })
);

it.live("an unrelated held bulk decision does not consume another item's autosave timer", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    const other = {
      ...test.detail.item,
      id: yield* Schema.decodeEffect(ReviewCommand.members[0].fields.id)(secondId),
    };
    test.view().editor(test.detail).change(edit("100"));
    const release = test.holdWrite();
    test.view().bulk(false, [other]);
    yield* advance(500);
    release();
    yield* advance(2000);
    expect(test.sent.map((command) => command._tag)).toEqual(["Skip", "SaveDraft"]);
    expect(test.view().editor(test.detail)).toMatchObject({
      feedback: "saved",
      draft: { amount: "100" },
    });
  })
);

it.live("bulk drain rechecks the original expiry after another item's held save", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    const detail: Detail = {
      ...test.detail,
      item: {
        ...test.detail.item,
        expiresAt: DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 100),
      },
    };
    test.view().editor(detail).recover();
    yield* advance(0);
    const other: Detail = {
      ...test.detail,
      item: {
        ...test.detail.item,
        id: yield* Schema.decodeEffect(ReviewCommand.members[0].fields.id)(secondId),
      },
    };
    const release = test.holdWrite();
    test.view().editor(other).change(edit("200"));
    test.view().bulk(false, [test.detail.item, other.item]);
    yield* advance(200);
    release();
    yield* advance(0);
    expect(test.sent.map((command) => command._tag)).toEqual(["SaveDraft"]);
    expect(Option.isNone(test.view().completed)).toBe(true);
  })
);

it.live("a late bulk acknowledgment cannot publish completion or Undo after original expiry", () =>
  Effect.gen(function* () {
    const test = yield* fixture(Option.some(100));
    const item = test.detail.item;
    const release = test.holdWrite();
    test.view().bulk(false, [item]);
    yield* advance(200);
    release();
    yield* advance(0);
    expect(test.sent.map((command) => command._tag)).toEqual(["Skip"]);
    expect(Option.isNone(test.view().completed)).toBe(true);
    expect(test.view().undoCount).toBe(0);
  })
);
