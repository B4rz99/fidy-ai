import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, DateTime, Effect, Schema } from "effect";
import { expect } from "vitest";
import { alice, nativeTransactionJourney } from "../financial-user-store.test-fixture";
import { native } from "../user-store.test-fixture";

const issuedFixture = Effect.gen(function* () {
  const db = yield* nativeTransactionJourney;
  const current = yield* Clock.currentTimeMillis;

  const init = {
    method: "POST",
    headers: {
      origin: "https://app.fidyapp.com",
      cookie: "__Host-fidy_session=" + alice.bearer,
      "Fidy-Session-Binding": alice.session,
      "Fidy-Retry-Key": "reviewed-manual-issue",
      "content-type": "application/json",
    },
    body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      requestId: "816551ab-a25e-4167-b87c-f7cc68890071",
      grant: {
        recipientLabel: "Terminal",
        scopes: ["write"],
        lifetimeDays: 7,
        reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(current + 604800000)),
      },
    }),
  };

  const issue = (): Effect.Effect<Response> =>
    native(() => db.send(new Request("https://api.fidyapp.com/pats", init)));

  const issued = yield* issue();
  expect(issued.status).toBe(200);

  const { data } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      data: Schema.Struct({
        bearer: Schema.String,
        pat: Schema.Struct({ shortId: Schema.String }),
      }),
    })
  )(yield* native(() => issued.json()));

  const call = (path: string, body?: unknown): Effect.Effect<Response> =>
    native(() =>
      db.send(
        new Request("https://api.fidyapp.com" + path, {
          method: body === undefined ? "GET" : "POST",
          headers: { authorization: "Bearer " + data.bearer, "content-type": "application/json" },
          body: body === undefined ? null : JSON.stringify(body),
        })
      )
    );

  return { db, call, shortId: data.pat.shortId, bearer: data.bearer, issue };
});

const capture = {
  money: { amount: "23.50", currency: "COP" },
  direction: "outflow",
  occurredAt: "2026-09-01T12:00:00.000Z",
};

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("returns the manual bearer once and retains no replayable secret", () =>
    Effect.gen(function* () {
      const { db, issue, bearer } = yield* issuedFixture;
      const repeated = yield* issue();
      expect(repeated.status).toBe(409);
      expect(yield* native(() => repeated.text())).not.toContain(bearer);
      expect(yield* native(() => db.exec("SELECT count(*) AS n FROM pats"))).toEqual([{ n: 1 }]);

      const receipts = yield* native(() =>
        db.exec(
          "SELECT body FROM canonical_request_receipts WHERE operation='pats.createManualPAT' AND body IS NOT NULL"
        )
      );

      expect(receipts).toEqual([]);
      expect(
        yield* native(() =>
          db.exec("SELECT part FROM canonical_receipt_parts WHERE instr(part,?)>0", bearer)
        )
      ).toEqual([]);
    })
  );
  test.effect(
    "preserves standing on scope and input refusal, rolls back refused Audit, and records PAT use at fixed expiry",
    () =>
      Effect.gen(function* () {
        const { db, call, shortId } = yield* issuedFixture;

        const denied = yield* call("/categories"),
          invalid = yield* call("/transactions", { not: "a transaction" });

        expect([denied.status, invalid.status]).toEqual([403, 400]);

        for (const response of [denied, invalid]) {
          expect(response.headers.get("Fidy-Canonical-Remaining")).toBe("50");
        }

        const inspect = (): Effect.Effect<Awaited<ReturnType<typeof db.exec>>> =>
          native(() =>
            db.exec("SELECT expires_at_ms,last_used_at_ms FROM pats WHERE short_id=?", shortId)
          );

        const [before] = yield* inspect();
        expect(before).toMatchObject({ last_used_at_ms: null });
        yield* native(() =>
          db.exec(
            "CREATE TRIGGER refuse_audit BEFORE INSERT ON audit_entries WHEN NEW.record_type='credential_call' AND NEW.operation='transactions.createTransaction' AND NEW.outcome='accepted' BEGIN SELECT RAISE(IGNORE); END"
          )
        );
        expect((yield* call("/transactions", capture)).status).toBe(503);
        expect(yield* native(() => db.exec("SELECT count(*) AS n FROM transactions"))).toEqual([
          { n: 0 },
        ]);
        expect(yield* inspect()).toEqual([before]);
        yield* native(() => db.exec("DROP TRIGGER refuse_audit"));
        expect((yield* call("/transactions", capture)).status).toBe(201);
        const usage = yield* inspect();
        expect(usage).toHaveLength(1);
        expect(usage[0]?.expires_at_ms).toBe(before?.expires_at_ms);
        expect(usage[0]?.last_used_at_ms).toEqual(expect.any(Number));
        const listing = yield* native(() => db.browser(0, "/pats"));

        const listed = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            data: Schema.Struct({
              pats: Schema.Tuple([
                Schema.Struct({ shortId: Schema.String, lastUsedAt: Schema.String }),
              ]),
            }),
          })
        )(yield* native(() => listing.json()));

        expect(listed.data.pats[0].shortId).toBe(shortId);
      })
  );
  test.effect("rechecks the PAT before returning protected Category and Transaction reads", () =>
    Effect.gen(function* () {
      const { db, call } = yield* issuedFixture;
      yield* native(() => db.exec("UPDATE pats SET scopes_json='[\"read\"]'"));
      yield* native(() =>
        db.exec(
          "CREATE TRIGGER change_scope BEFORE UPDATE OF last_used_at_ms ON pats BEGIN UPDATE pats SET scopes_json='[\"dashboard\"]' WHERE id=OLD.id; END"
        )
      );

      yield* Effect.forEach(
        ["/categories", "/transactions"],
        Effect.fnUntraced(function* (path) {
          expect((yield* call(path)).status).toBe(503);
        }),
        { discard: true }
      );

      expect(
        yield* native(() =>
          db.exec(
            "SELECT count(*) AS n FROM audit_entries WHERE operation IN ('categories.listCategories','transactions.listTransactions') AND outcome='accepted'"
          )
        )
      ).toEqual([{ n: 0 }]);
      yield* native(() => db.exec("DROP TRIGGER change_scope"));
      expect((yield* call("/categories")).status).toBe(200);
    })
  );
});
