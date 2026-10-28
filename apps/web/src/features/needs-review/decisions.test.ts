import { Clock, DateTime, Effect, Fiber, Layer, Option, Schema } from "effect";
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
  dispose: () => void;
  failWrite: (value: boolean) => void;
  failRead: (value: boolean) => void;
  missingResult: () => void;
  delay: (value: number) => void;
};
const fixture = Effect.fnUntraced(function* () {
  vi.useFakeTimers();
  vi.setSystemTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-28T00:00:00Z")));
  const entries = new Map<string, Saved>(
    [firstId, secondId].map((id) => [id, { item: fixtureItem(id), revision: 0, draft: undefined }])
  );
  const sent: Array<ReviewCommand> = [];
  let failWrite = false;
  let failRead = false;
  let missingResult = false;
  let delay = 0;
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const path = new URL(request.url).pathname;
      let data: unknown;
      if (request.method === "POST") {
        const command = yield* Schema.decodeEffect(Schema.fromJsonString(ReviewCommand))(
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : ""
        );
        sent.push(command);
        yield* Effect.sleep(delay);
        data = applyFixture(entries, command);
        if (failWrite) {
          return HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 }));
        }
        if (missingResult) data = [];
      } else {
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
    delay: (value: number): void => {
      delay = value;
    },
  };
  return fixture;
});
const advance = Effect.fnUntraced(function* (milliseconds: number) {
  yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(milliseconds));
});
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
      test.view().change(test.detail, edit("98765"));
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

it.live("serializes new draft changes behind an in-flight save before deciding", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    test.delay(100);
    test.view().change(test.detail, edit("100"));
    yield* advance(650);
    test.view().change(test.detail, edit("200"));
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
      test.view().change(test.detail, edit("42000"));
      yield* advance(650);
      expect(test.view().editor(test.detail).feedback).toBe("uncertain");
      test.view().decide(test.detail, "Skip");
      test.failRead(true);
      test.view().recoverItem(test.detail);
      yield* advance(2000);
      expect(test.view().editor(test.detail).locked).toBe(true);
      test.failRead(false);
      test.view().recoverItem(test.detail);
      yield* advance(0);
      expect(test.view().editor(test.detail)).toMatchObject({
        locked: false,
        draft: { amount: "42000" },
      });
      expect(test.sent).toHaveLength(1);
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
      retained.change(test.detail, edit("100"));
      test.dispose();
      retained.change(test.detail, edit("200"));
      retained.decide(test.detail, "Skip");
      yield* advance(1000);
      expect(test.sent).toHaveLength(0);
    })
);

it.live("disposal during a save prevents its queued decision and ignores a late result", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    test.delay(200);
    test.view().change(test.detail, edit("100"));
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
    test.view().change(detail, edit("100"));
    yield* advance(1000);
    expect(test.sent).toHaveLength(0);
    expect(test.view().editor(detail).locked).toBe(true);
  })
);

it.live("an incomplete save acknowledgement blocks the following decision", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    test.missingResult();
    test.view().change(test.detail, edit("100"));
    test.view().decide(test.detail, "Skip");
    yield* advance(0);
    expect(test.view().editor(test.detail).feedback).toBe("uncertain");
    expect(test.sent).toHaveLength(1);
  })
);

it.live("keeps a failed item's lock local while allowing another item to save", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    test.failWrite(true);
    test.view().change(test.detail, edit("100"));
    yield* advance(650);
    test.failWrite(false);
    const other: Detail = {
      ...test.detail,
      item: {
        ...test.detail.item,
        id: yield* Schema.decodeEffect(ReviewCommand.members[0].fields.id)(secondId),
      },
    };
    test.view().change(other, edit("200"));
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
    test.view().change(test.detail, edit("100"));
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
    test.view().change(other, edit("200"));
    test.view().bulk(false, [expiring, other.item]);
    yield* advance(400);
    expect(test.sent.map((command) => command._tag)).toEqual(["SaveDraft"]);
    expect(test.view().locked).toBe(true);
  })
);
