import type { Miniflare } from "miniflare";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import { expect } from "vitest";
import { oauthPaths } from "../../src/shell/oauth-agents/contract";
import { operationCatalog } from "../../src/shell/api";
import { canonicalAllowanceHeaders } from "../../src/shell/quotas/contract";
import { DisclosureSnapshot } from "../../src/shell/consent/contract";
import { currentDisclosureFor } from "../../src/shell/consent/operations";
import { native, nativeLostReadPlatform } from "../user-store.test-fixture";
import { alice, bob, makeNativeTransactionJourney } from "../financial-user-store.test-fixture";

const listings = [
  ["pats.listPATs", ""],
  ["subscription.listSubscriptionOffers", ""],
  ["subscription.getSubscriptionStatus", ""],
  ["recurringPlans.getRecurringWorkspace", "?month=2026-10&view=compact"],
  ["categories.listCategories", ""],
  ["dashboard.listDashboardCatalog", ""],
  ["budgets.getBudgetStatus", "?timeZone=America%2FBogota"],
  ["ingestion.getReviewWorkspace", ""],
  ["ingestion.getReviewPageContext", ""],
] as const;

const endpoints = listings.map(([id, query]) => {
  const op = operationCatalog.byId.get(id);

  if (op === undefined) throw new Error("Missing operation " + id);

  return { id, path: op.route + query, operation: op };
});

const fixture = Effect.gen(function* () {
  const store = yield* makeNativeTransactionJourney(undefined, nativeLostReadPlatform);

  const sql = (
    ...args: Parameters<typeof store.exec>
  ): Effect.Effect<Awaited<ReturnType<typeof store.exec>>> => native(() => store.exec(...args));

  const now = yield* Clock.currentTimeMillis;
  yield* sql(
    "UPDATE users SET trial_started_at_ms=created_at_ms-1209600000,trial_ends_at_ms=created_at_ms-604800000 WHERE id=?",
    alice.user
  );
  yield* native(() =>
    store
      .owner(bob.user)
      .exec(
        "UPDATE users SET trial_started_at_ms=created_at_ms,trial_ends_at_ms=created_at_ms+604800000 WHERE id=?",
        bob.user
      )
  );

  const request = (path: string, headers: Record<string, string> = {}): Effect.Effect<Response> =>
    native(() =>
      store.send(
        new Request("https://api.fidyapp.com" + path, {
          headers: {
            origin: "https://app.fidyapp.com",
            cookie: "__Host-fidy_session=" + alice.bearer,
            "Fidy-Session-Binding": alice.session,
            ...headers,
          },
        })
      )
    );

  const counts = (): ReturnType<typeof sql> =>
    sql(
      "SELECT (SELECT count(*) FROM audit_entries) AS audit,(SELECT count(*) FROM canonical_request_buckets) AS buckets,(SELECT count(*) FROM canonical_request_leases) AS leases,(SELECT count(*) FROM commercial_allowance_consumptions) AS charges"
    );

  return { store, sql, request, counts, now };
});

const refusedHeaders: ReadonlyArray<Record<string, string>> = [
  { authorization: "Bearer invalid" },
  { "Fidy-Session-Binding": "" },
  { "Fidy-Session-Binding": bob.session },
  { cookie: "" },
];

type Subject = Effect.Success<typeof fixture>;

type Endpoint = (typeof endpoints)[number];

const refusedCredential = Effect.fnUntraced(function* (
  subject: Subject,
  target: Endpoint,
  headers: Readonly<Record<string, string>>
) {
  const response = yield* subject.request(target.path, headers);
  expect(response.status, target.id + " " + Object.keys(headers).join(",")).toBe(401);
});

const wrongCredentials = Effect.fnUntraced(function* (subject: Subject) {
  const before = yield* subject.counts();

  yield* Effect.forEach(
    endpoints,
    (target) =>
      Effect.forEach(refusedHeaders, (headers) => refusedCredential(subject, target, headers), {
        discard: true,
      }),
    { discard: true }
  );

  expect(yield* subject.counts()).toEqual(before);
});

const refusedListing = Effect.fnUntraced(function* (
  subject: Subject,
  mode: "revoked" | "expired" | "withdrawn",
  target: Endpoint
) {
  const response = yield* subject.request(target.path);
  expect(response.status, mode + " " + target.id).toBe(401);
});

const mismatchedCookie = Effect.fnUntraced(function* (
  core: Awaited<ReturnType<Miniflare["getWorker"]>>,
  [method, path]: readonly [string, string]
) {
  const reply = yield* native(() =>
    core.fetch("https://api.fidyapp.com" + path, {
      method,
      headers: {
        cookie: "__Host-fidy_session=" + alice.bearer,
        "Fidy-Session-Binding": bob.session,
      },
    })
  );

  const replyBody = yield* native(() => reply.text());
  expect(reply.status, path + " " + replyBody).toBe(401);
});

const completeListing = Effect.fnUntraced(function* (subject: Subject, target: Endpoint) {
  const response = yield* subject.request(target.path);
  expect(response.status, target.id).toBe(200);
  const body = yield* native(() => response.json());
  yield* Schema.decodeUnknownEffect(target.operation.success)(body);
  expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(body)).not.toContain(
    "unrelated invalid Category"
  );
  const limit = response.headers.get(canonicalAllowanceHeaders.limit);
  expect(limit, target.id).toMatch(/^[1-9][0-9]*$/u);
  expect(response.headers.get(canonicalAllowanceHeaders.remaining), target.id).toBe(limit);
});

const throttledListing = Effect.fnUntraced(function* (subject: Subject, target: Endpoint) {
  const reply = yield* subject.request(target.path);
  expect(reply.status, target.id).toBe(429);
  expect(reply.headers.get("retry-after"), target.id).toBe("1");
});

const unavailableListing = Effect.fnUntraced(function* (subject: Subject, target: Endpoint) {
  expect((yield* subject.request(target.path)).status, target.id).toBe(503);
});

const lostReplyListing = Effect.fnUntraced(function* (subject: Subject, target: Endpoint) {
  const path = target.path.split("?")[0];
  yield* subject.sql("INSERT INTO lose_read_reply VALUES(?)", path);
  expect((yield* subject.request(target.path)).status, target.id).toBe(503);
  expect(
    yield* subject.sql(
      "SELECT count(*) AS n FROM audit_entries WHERE operation=? AND record_type='session_call'",
      target.id
    ),
    target.id
  ).toEqual([{ n: 1 }]);
  expect(yield* subject.sql("SELECT count(*) AS n FROM lose_read_reply")).toEqual([{ n: 0 }]);
});

const refusedStanding = Effect.fnUntraced(function* (mode: "revoked" | "expired" | "withdrawn") {
  const subject = yield* fixture;

  if (mode === "revoked") {
    yield* subject.sql(
      "UPDATE web_sessions SET revoked_at_ms=? WHERE id=?",
      subject.now,
      alice.session
    );
  }

  if (mode === "expired") {
    yield* subject.sql(
      "UPDATE web_sessions SET idle_expires_at_ms=? WHERE id=?",
      subject.now,
      alice.session
    );
  }

  if (mode === "withdrawn") {
    const snapshot = yield* Schema.encodeEffect(Schema.fromJsonString(DisclosureSnapshot))(
      currentDisclosureFor()
    );

    yield* subject.sql(
      "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms,disclosure_json) VALUES('grant',?,'processing_grant',?,?)",
      alice.user,
      subject.now,
      snapshot
    );
    yield* subject.sql(
      "INSERT INTO consent_history(id,user_id,record_type,grant_record_id,session_id,occurred_at_ms) VALUES('withdraw',?,'processing_withdrawal','grant',?,?)",
      alice.user,
      alice.session,
      subject.now
    );
  }

  const before = yield* subject.counts();

  yield* Effect.forEach(endpoints, (target) => refusedListing(subject, mode, target), {
    discard: true,
  });

  expect(yield* subject.counts()).toEqual(before);
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "refuses absent or mismatched binding, missing cookies and explicit invalid authorization for every listing before accounting",
    () =>
      Effect.gen(function* () {
        yield* wrongCredentials(yield* fixture);
      })
  );
  test.effect(
    "rejects a mismatched mounted cookie before independent provider, support, health or bootstrap work",
    () =>
      Effect.gen(function* () {
        const subject = yield* fixture;
        const core = yield* native(() => subject.store.runtime.getWorker("core"));

        const routes: ReadonlyArray<readonly [string, string]> = [
          ["GET", oauthPaths.authorize],
          ["POST", "/providers/kapso/callback"],
          ["POST", "/web/subscription/payment-enrollments/prepare"],
          ["POST", "/web/hosted-turns"],
          ["GET", "/user"],
          ["GET", "/health"],
          ["POST", "/internal/titular-erasure"],
        ];

        const before = yield* subject.counts();

        yield* Effect.forEach(routes, (route) => mismatchedCookie(core, route), { discard: true });

        expect(yield* subject.counts()).toEqual(before);
      })
  );

  for (const state of ["revoked", "expired", "withdrawn"] as const) {
    test.effect(
      "refuses every listing with " + state + " authority without charging or disclosing",
      () => refusedStanding(state)
    );
  }

  test.effect("preserves each User's quota, active leases and complete listing response", () =>
    Effect.gen(function* () {
      const subject = yield* fixture;
      yield* subject.sql(
        "INSERT INTO canonical_request_leases VALUES('own',?,?)",
        alice.user,
        subject.now + 60000
      );
      yield* native(() =>
        subject.store
          .owner(bob.user)
          .exec(
            "INSERT INTO canonical_request_leases VALUES('other-1',?,?),('other-2',?,?)",
            bob.user,
            subject.now + 60000,
            bob.user,
            subject.now + 60000
          )
      );
      yield* subject.sql(
        "INSERT INTO categories VALUES('invalid-category','unrelated invalid Category',1000000)"
      );

      yield* Effect.forEach(endpoints, (target) => completeListing(subject, target), {
        discard: true,
      });

      expect(yield* subject.sql("SELECT id FROM canonical_request_leases")).toEqual([
        { id: "own" },
      ]);
      expect(
        yield* native(() =>
          subject.store.owner(bob.user).exec("SELECT count(*) AS n FROM canonical_request_leases")
        )
      ).toEqual([{ n: 2 }]);
      expect(
        yield* subject.sql("SELECT count(*) AS n FROM commercial_allowance_consumptions")
      ).toEqual([{ n: 0 }]);
    })
  );

  test.effect.each(["rate", "concurrency"] as const)(
    "enforces shared %s protection across all canonical listings",
    (pressure) =>
      Effect.gen(function* () {
        const subject = yield* fixture;

        if (pressure === "rate") {
          yield* subject.sql(
            "INSERT INTO canonical_request_buckets VALUES(?,?)",
            "user:" + alice.user,
            subject.now + 60000
          );
        } else {
          yield* subject.sql(
            "INSERT INTO canonical_request_leases VALUES('first',?,?),('second',?,?)",
            alice.user,
            subject.now + 60000,
            alice.user,
            subject.now + 60000
          );
        }

        const before = yield* subject.counts();

        yield* Effect.forEach(endpoints, (target) => throttledListing(subject, target), {
          discard: true,
        });

        expect(yield* subject.counts()).toEqual(before);
      })
  );

  test.effect(
    "rolls back admission and disclosures if the User cannot commit the required Audit",
    () =>
      Effect.gen(function* () {
        const subject = yield* fixture;
        yield* subject.sql(
          "CREATE TRIGGER interrupt_audit BEFORE INSERT ON audit_entries BEGIN SELECT RAISE(IGNORE); END"
        );
        const before = yield* subject.counts();

        yield* Effect.forEach(endpoints, (target) => unavailableListing(subject, target), {
          discard: true,
        });

        expect(yield* subject.counts()).toEqual(before);
      })
  );
  test.effect(
    "losing a committed owner reply returns unavailable and never repeats listing work",
    () =>
      Effect.gen(function* () {
        const subject = yield* fixture;
        yield* subject.sql("CREATE TABLE lose_read_reply(path TEXT PRIMARY KEY) STRICT");

        yield* Effect.forEach(endpoints, (target) => lostReplyListing(subject, target), {
          discard: true,
        });

        expect(
          yield* subject.sql("SELECT count(*) AS n FROM commercial_allowance_consumptions")
        ).toEqual([{ n: 0 }]);
        expect(yield* subject.sql("SELECT count(*) AS n FROM canonical_request_leases")).toEqual([
          { n: 0 },
        ]);
      })
  );
});
