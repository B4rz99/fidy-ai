import { it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Clock, Effect, Result, Schema } from "effect";
import { expect } from "vitest";
import { DisclosureSnapshot } from "../../src/core/consent/contract";
import { currentDisclosureFor, webSignupDisclosure } from "../../src/shell/consent/operations";
import {
  ProcessingAuthorization,
  ProcessingConsentStatus,
} from "../../src/shell/processing-consent/contract";
import { alice, bob, nativeTransactionJourney } from "../financial-user-store.test-fixture";
import { native } from "../user-store.test-fixture";

const path = "/web/consent",
  auth = path + "/authorization",
  withdrawal = path + "/withdraw",
  renewal = path + "/renew";

const grantId = "30000000-0000-4000-8000-000000000000",
  remoteGrant = "30000000-0000-4000-8000-000000000001";

type Journey = Effect.Success<typeof nativeTransactionJourney>;

type Call = { user: typeof alice; path: string } & Partial<
  Readonly<{ method: string; body: unknown; headers: Readonly<Record<string, string>> }>
>;

const send = Effect.fn(function* (db: Journey, input: Call) {
  const init = {
    method: input.method ?? "GET",
    headers: {
      origin: "https://app.fidyapp.com",
      "content-type": "application/json",
      "fidy-session-binding": input.user.session,
      cookie: "__Host-fidy_session=" + input.user.bearer,
      ...input.headers,
    },
  };

  return yield* native(() =>
    db.send(
      new Request(
        "https://api.fidyapp.com" + input.path,
        input.method === "GET" || input.body === undefined
          ? init
          : { ...init, body: JSON.stringify(input.body) }
      )
    )
  );
});

const json = Effect.fn(function* <Value, Encoded>(
  reply: Response,
  codec: Schema.Codec<Value, Encoded>
) {
  expect(reply.status).toBe(200);

  return yield* Schema.decodeUnknownEffect(codec)(yield* native(() => reply.json()));
});

const expectStatus = Effect.fn(function* (db: Journey, input: Call, status: number) {
  expect((yield* send(db, input)).status, String(status)).toBe(status);
});

const refusedConsentRead = Effect.fn(function* (db: Journey, testPath: string) {
  const reply = yield* send(
    db,
    testPath === withdrawal
      ? { user: alice, path: testPath, method: "POST", body: { confirm: true } }
      : { user: alice, path: testPath }
  );

  expect(reply.status).toBe(401);
  expect(yield* native(() => reply.text())).not.toContain(webSignupDisclosure().contentSha256);
});

const historyMutations = ["processing_withdrawal", "processing_renewal"].flatMap((type) =>
  [
    "UPDATE consent_history SET occurred_at_ms=0 WHERE record_type=?",
    "DELETE FROM consent_history WHERE record_type=?",
  ].map((statement) => [type, statement] as const)
);

const refusedHistoryMutation = Effect.fn(function* (
  db: Journey,
  [type, statement]: readonly [string, string]
) {
  const result = yield* Effect.result(Effect.tryPromise(() => db.exec(statement, type)));
  expect(Result.isFailure(result)).toBe(true);
});

const granted = Effect.fn(function* (
  db: Journey,
  subject: typeof alice,
  { reference, disclosure }: { reference: string; disclosure: DisclosureSnapshot }
) {
  const saved = yield* Schema.encodeEffect(Schema.fromJsonString(DisclosureSnapshot))(disclosure);
  const now = yield* Clock.currentTimeMillis;
  yield* native(() =>
    db
      .owner(subject.user)
      .exec(
        "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms,disclosure_json) VALUES(?,?,'processing_grant',?,?)",
        reference,
        subject.user,
        now,
        saved
      )
  );

  return { reference, acceptedAtMs: now, disclosure };
});

const setup = Effect.fn(function* () {
  const db = yield* nativeTransactionJourney;

  const first = yield* granted(db, alice, {
    reference: grantId,
    disclosure: webSignupDisclosure(),
  });

  const second = yield* granted(db, bob, {
    reference: remoteGrant,
    disclosure: currentDisclosureFor(),
  });

  return { db, first, second };
});

const withdraw = (db: Journey): ReturnType<typeof send> =>
  send(db, { user: alice, path: withdrawal, method: "POST", body: { confirm: true } });

const decision = Effect.fn(function* (db: Journey) {
  const reply = yield* json(yield* withdraw(db), ProcessingConsentStatus);

  if (reply.status !== "Revoked") throw Error("Missing native withdrawal");

  return {
    confirm: true,
    withdrawalReference: reply.withdrawal.reference,
    authorizationReference: grantId,
    disclosureSha256: webSignupDisclosure().contentSha256,
  };
});

const original = Effect.fn(function* (db: Journey) {
  return yield* json(yield* send(db, { user: alice, path: auth }), ProcessingAuthorization);
});

const counts = Effect.fn(function* (db: Journey, user: typeof alice) {
  return yield* native(() =>
    db
      .owner(user.user)
      .exec(
        "SELECT (SELECT count(*) FROM consent_history WHERE record_type!='processing_grant') AS decisions,(SELECT count(*) FROM audit_entries WHERE operation IN('consent.withdraw','consent.renew') AND outcome='accepted') AS audit"
      )
  );
});

const cancelledDelivery = Effect.fn(function* (db: Journey, target: string) {
  const body = target === withdrawal ? { confirm: true } : yield* decision(db);
  const before = yield* counts(db, alice);
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(body);

  const outcome = yield* Effect.result(
    Effect.tryPromise(() =>
      db.runtime.dispatchFetch("https://api.fidyapp.com" + target, {
        method: "POST",
        headers: {
          origin: "https://app.fidyapp.com",
          cookie: "__Host-fidy_session=" + alice.bearer,
          "fidy-session-binding": alice.session,
          "content-type": "application/json",
        },
        body: encoded,
        signal: AbortSignal.abort(),
      })
    )
  );

  expect(Result.isSuccess(outcome) ? outcome.success.status : 503).toBe(503);
  expect(yield* counts(db, alice)).toEqual(before);
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "returns each original signup disclosure before and after withdrawal, renews its exact reference once and allows a new withdrawal",
    () =>
      Effect.gen(function* () {
        const { db, first, second } = yield* setup();
        expect(yield* original(db)).toEqual({ authorization: first });
        const body = yield* decision(db);
        expect(yield* original(db)).toEqual({ authorization: first });
        expect(
          yield* json(yield* send(db, { user: bob, path: auth }), ProcessingAuthorization)
        ).toEqual({ authorization: second });

        yield* Effect.forEach(
          [
            { user: bob, body },
            { user: alice, body: { ...body, authorizationReference: remoteGrant } },
            { user: alice, body: { ...body, disclosureSha256: "0".repeat(64) } },
          ],
          (input) => expectStatus(db, { ...input, path: renewal, method: "POST" }, 403),
          { discard: true }
        );

        const renew = (): ReturnType<typeof send> =>
          send(db, { user: alice, path: renewal, method: "POST", body });

        const one = yield* renew(),
          repeated = yield* renew();

        expect(one.status).toBe(200);
        expect(yield* native(() => repeated.text())).toBe(yield* native(() => one.text()));
        expect(yield* counts(db, alice)).toEqual([{ decisions: 2, audit: 2 }]);
        expect(yield* counts(db, bob)).toEqual([{ decisions: 0, audit: 0 }]);
        const next = yield* decision(db);
        expect(next.withdrawalReference).not.toBe(body.withdrawalReference);
        expect((yield* renew()).status).toBe(403);
      })
  );
  test.effect(
    "keeps pressure retryable and refuses hostile, mixed, oversized and mismatched browser decisions before legal or accounting effects",
    () =>
      Effect.gen(function* () {
        const { db } = yield* setup();

        const attempts: ReadonlyArray<Partial<Call> & { status: number }> = [
          { headers: { origin: "https://other.example" }, status: 403 },
          { headers: { authorization: "Bearer forbidden" }, status: 403 },
          { headers: { "fidy-session-binding": bob.session }, status: 401 },
          { body: { confirm: false }, status: 400 },
          { body: { confirm: true, extra: "x" }, status: 400 },
          { body: { confirm: "x".repeat(2048) }, status: 400 },
          { method: "GET", status: 405 },
        ];

        yield* Effect.forEach(
          attempts,
          ({ status, ...request }) =>
            expectStatus(
              db,
              {
                user: alice,
                path: withdrawal,
                method: "POST",
                body: { confirm: true },
                ...request,
              },
              status
            ),
          { discard: true }
        );

        const available = (yield* Clock.currentTimeMillis) + 60000;
        yield* native(() =>
          db.exec(
            "INSERT OR REPLACE INTO canonical_request_buckets VALUES(?,?)",
            "user:" + alice.user,
            available
          )
        );
        const refused = yield* send(db, { user: alice, path });
        expect(refused.status).toBe(429);
        expect(refused.headers.get("retry-after")).toBe("1");
        expect(refused.headers.get("cache-control")).toBe("no-store");
        yield* native(() => db.exec("DELETE FROM canonical_request_buckets"));
        expect((yield* send(db, { user: alice, path })).status).toBe(200);
        expect(yield* counts(db, alice)).toEqual([{ decisions: 0, audit: 0 }]);
      })
  );
  test.effect.each(["ignore", "abort"] as const)(
    "rolls back withdrawal and renewal with their Audit when SQLite rejects publication by %s and preserves replay",
    (failure) =>
      Effect.gen(function* () {
        const { db } = yield* setup();

        const interrupt = (action: string): Effect.Effect<unknown> =>
          native(() =>
            db.exec(
              "CREATE TRIGGER break_decision BEFORE INSERT ON audit_entries WHEN NEW.operation='" +
                action +
                "' BEGIN SELECT " +
                (failure === "ignore" ? "RAISE(IGNORE)" : "RAISE(ABORT,'required_audit')") +
                "; END"
            )
          );

        yield* interrupt("consent.withdraw");
        expect((yield* withdraw(db)).status).toBe(503);
        expect(yield* counts(db, alice)).toEqual([{ decisions: 0, audit: 0 }]);
        yield* native(() => db.exec("DROP TRIGGER break_decision"));
        const body = yield* decision(db);
        yield* interrupt("consent.renew");

        const renew = (): ReturnType<typeof send> =>
          send(db, { user: alice, path: renewal, method: "POST", body });

        expect((yield* renew()).status).toBe(503);
        expect(yield* counts(db, alice)).toEqual([{ decisions: 1, audit: 1 }]);
        yield* native(() => db.exec("DROP TRIGGER break_decision"));

        const accepted = yield* renew(),
          replay = yield* renew();

        expect(accepted.status).toBe(200);
        expect(yield* native(() => accepted.text())).toBe(yield* native(() => replay.text()));
        expect(yield* counts(db, alice)).toEqual([{ decisions: 2, audit: 2 }]);
      })
  );
  test.effect.each(["idle", "hard", "revoked", "foreign-route", "retired-binding"] as const)(
    "revalidates %s proof inside the original User before any disclosure or new decision",
    (mode) =>
      Effect.gen(function* () {
        const { db } = yield* setup();

        if (mode === "foreign-route") {
          yield* native(() =>
            db.directory.exec(
              "UPDATE session_routes SET user_id=? WHERE session_id=?",
              bob.user,
              alice.session
            )
          );
        } else if (mode === "retired-binding") {
          yield* native(() =>
            db.directory.exec("DELETE FROM session_routes WHERE session_id=?", alice.session)
          );
        } else if (mode === "revoked") {
          yield* native(() => db.exec("UPDATE web_sessions SET revoked_at_ms=created_at_ms"));
        } else if (mode === "hard") {
          yield* native(() =>
            db.exec(
              "UPDATE web_sessions SET created_at_ms=0,fresh_until_ms=600000,idle_expires_at_ms=7776000000,hard_expires_at_ms=7776000000"
            )
          );
        } else {
          yield* native(() => db.exec("UPDATE web_sessions SET idle_expires_at_ms=created_at_ms"));
        }

        yield* Effect.forEach(
          [path, auth, withdrawal],
          (testPath) => refusedConsentRead(db, testPath),
          { discard: true }
        );

        expect(yield* counts(db, alice)).toEqual([{ decisions: 0, audit: 0 }]);
        expect(yield* counts(db, bob)).toEqual([{ decisions: 0, audit: 0 }]);
      })
  );
  test.effect.each(["copy", "withdraw", "renew"] as const)(
    "revalidates original clock and credential after admitted pressure or receipt work for %s",
    (mode) =>
      Effect.gen(function* () {
        const { db } = yield* setup(),
          body = mode === "renew" ? yield* decision(db) : { confirm: true };

        const before = yield* counts(db, alice);
        yield* native(() => db.exec("DELETE FROM canonical_request_buckets"));

        const edge =
          mode === "copy"
            ? "AFTER INSERT ON canonical_request_buckets"
            : "AFTER INSERT ON audit_entries WHEN NEW.operation='consent." + mode + "'";

        yield* native(() =>
          db.exec(
            "CREATE TRIGGER revoke_in_flight " +
              edge +
              " BEGIN UPDATE web_sessions SET revoked_at_ms=created_at_ms; END"
          )
        );

        const target = { copy: auth, renew: renewal, withdraw: withdrawal }[mode];

        const result = yield* send(
          db,
          mode === "copy"
            ? { user: alice, path: target }
            : { user: alice, path: target, method: "POST", body }
        );

        expect(result.status).toBe(401);
        expect(yield* native(() => result.text())).not.toContain(
          webSignupDisclosure().contentSha256
        );
        expect(yield* counts(db, alice)).toEqual(before);
        expect(yield* counts(db, bob)).toEqual([{ decisions: 0, audit: 0 }]);
      })
  );
  test.effect(
    "a cancelled native browser delivery cannot publish withdrawal or renewal evidence",
    () =>
      Effect.gen(function* () {
        const { db } = yield* setup();

        yield* Effect.forEach([withdrawal, renewal], (target) => cancelledDelivery(db, target), {
          discard: true,
        });
      })
  );
  test.effect.each(["short", "long", "bad-character", "bad-json", "oversized"] as const)(
    "withholds malformed saved authorization (%s) without returning any legal copy",
    (mode) =>
      Effect.gen(function* () {
        const db = yield* nativeTransactionJourney;

        const saved = yield* Schema.encodeEffect(Schema.fromJsonString(DisclosureSnapshot))(
          webSignupDisclosure()
        );

        const corrupt = {
          short: { reference: "a".repeat(42), body: saved },
          long: { reference: "a".repeat(44), body: saved },
          "bad-character": { reference: "!".repeat(43), body: saved },
          "bad-json": { reference: grantId, body: "{" },
          oversized: { reference: grantId, body: saved + " ".repeat(32768) },
        };

        const { reference, body } = corrupt[mode];
        yield* native(() =>
          db.exec(
            "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms,disclosure_json) VALUES(?,?,'processing_grant',100,?)",
            reference,
            alice.user,
            body
          )
        );
        const reply = yield* send(db, { user: alice, path: auth });
        expect(reply.status).toBe(503);
        expect(yield* native(() => reply.text())).not.toContain(
          webSignupDisclosure().contentSha256
        );
      })
  );
  test.effect(
    "requires fresh proof for renewal and retains immutable legal evidence through a lost response",
    () =>
      Effect.gen(function* () {
        const { db } = yield* setup(),
          body = yield* decision(db);

        yield* native(() =>
          db.exec(
            "UPDATE web_sessions SET created_at_ms=created_at_ms-1200000,fresh_until_ms=fresh_until_ms-1200000,hard_expires_at_ms=hard_expires_at_ms-1200000"
          )
        );

        const renew = (): ReturnType<typeof send> =>
          send(db, { user: alice, path: renewal, method: "POST", body });

        expect((yield* renew()).status).toBe(401);
        expect(yield* counts(db, alice)).toEqual([{ decisions: 1, audit: 1 }]);
        yield* native(() =>
          db.exec(
            "UPDATE web_sessions SET created_at_ms=created_at_ms+1200000,fresh_until_ms=fresh_until_ms+1200000,hard_expires_at_ms=hard_expires_at_ms+1200000"
          )
        );
        expect((yield* renew()).status).toBe(200);

        yield* Effect.forEach(
          historyMutations,
          (mutation) => refusedHistoryMutation(db, mutation),
          { discard: true }
        );

        expect((yield* renew()).status).toBe(200);
        expect(yield* counts(db, alice)).toEqual([{ decisions: 2, audit: 2 }]);
      })
  );
});

it("rejects receipt/status combinations that cannot represent a processing authorization", () => {
  const decode = Schema.decodeUnknownOption(ProcessingConsentStatus);
  const receipt = { reference: alice.user, occurredAtMs: 1000 };

  for (const value of [
    { status: "Revoked", withdrawal: null },
    { status: "Granted", withdrawal: receipt },
    { status: "Missing", withdrawal: receipt },
  ]) {
    expect(decode(value)._tag).toBe("None");
  }

  expect(decode({ status: "Revoked", withdrawal: receipt })._tag).toBe("Some");
});
