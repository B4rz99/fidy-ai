import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { expect } from "vitest";
import { alice, bob, seed } from "../financial-user-store.test-fixture";
import { native, nativeBillingPlatform } from "../user-store.test-fixture";
import { currentDisclosureFor } from "../../src/shell/consent/operations";
import { DisclosureSnapshot } from "../../src/shell/consent/contract";

const setup = Effect.fn(function* (bsuid: string = "CO.13491208655302741918") {
  const runtime = yield* (yield* nativeBillingPlatform)(),
    owner = yield* seed(runtime, alice, false),
    other = yield* seed(runtime, bob, false);

  const portfolio = "123456789012345";
  yield* owner.exec(
    "UPDATE users SET whatsapp_portfolio_id=?,whatsapp_bsuid=?,whatsapp_verified_at_ms=? WHERE id=?",
    portfolio,
    bsuid,
    owner.now,
    alice.user
  );
  yield* native(() =>
    owner.directory.exec(
      "INSERT INTO whatsapp_routes(portfolio,bsuid,user_id,attempt_id,established) VALUES (?,?,?,?,1)",
      portfolio,
      bsuid,
      alice.user,
      "image-fixture"
    )
  );

  const deliver = Effect.fn(function* (message: string, caption?: string) {
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      message: {
        id: message,
        timestamp: String(Math.floor(owner.now / 1000)),
        type: caption === undefined ? "audio" : "image",
        from_user_id: bsuid,
        ...Option.match(Option.fromUndefinedOr(caption), {
          onNone: () => ({ audio: { id: "media_voice_sample" } }),
          onSome: (text) => ({ image: { id: "media_fidy_example_1", caption: text } }),
        }),
      },
      conversation: { business_scoped_user_id: bsuid },
      phone_number_id: portfolio,
    });

    const signature = new Bun.CryptoHasher("sha256", "callback-fixture-secret")
      .update(body)
      .digest("hex");

    return yield* native(() =>
      runtime.dispatchFetch("https://api.fidyapp.com/providers/kapso/callback", {
        method: "POST",
        headers: {
          "x-webhook-event": "whatsapp.message.received",
          "x-webhook-signature": signature,
          "x-idempotency-key": message,
        },
        body,
      })
    );
  });

  const grant = Effect.gen(function* () {
    yield* owner.exec(
      "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms,disclosure_json) VALUES('22570000-0000-4000-8000-000000000001',?,'processing_grant',?,?)",
      alice.user,
      owner.now,
      yield* Schema.encodeEffect(Schema.fromJsonString(DisclosureSnapshot))(currentDisclosureFor())
    );
  });

  return { owner, other, deliver, grant };
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "publishes a signed image only in its active User, atomically charging and retaining its original Review and media Audit",
    () =>
      Effect.gen(function* () {
        const { owner, other, deliver, grant } = yield* setup();

        const counts =
          "SELECT (SELECT count(*) FROM media_submissions) AS media,(SELECT count(*) FROM ingestion_review_items WHERE source_kind='media') AS review,(SELECT count(*) FROM audit_entries WHERE record_type='media_admission') AS audit,(SELECT coalesce(sum(units),0) FROM commercial_allowance_consumptions WHERE allowance='media_submission') AS units";

        expect((yield* deliver("wamid.media1", "original")).status).toBe(403);
        expect(yield* owner.exec(counts)).toEqual([{ media: 0, review: 0, audit: 0, units: 0 }]);
        yield* grant;
        const first = yield* deliver("wamid.media1", "original");
        expect(first.status).toBe(202);
        const result = yield* native(() => first.json());
        expect(result).toMatchObject({
          data: {
            status: "needs-review",
            reason: "extraction-unavailable",
            allowance: { consumed: 1, remaining: 1 },
          },
        });
        expect(result).toHaveProperty("data.allowance._tag", "Limited");
        const replay = yield* deliver("wamid.media1", "original");
        expect(yield* native(() => replay.json())).toEqual(result);
        expect((yield* deliver("wamid.media1", "changed")).status).toBe(409);
        expect(yield* owner.exec(counts)).toEqual([{ media: 1, review: 1, audit: 1, units: 1 }]);
        expect((yield* deliver("wamid.media2", "next")).status).toBe(202);
        expect((yield* deliver("wamid.media3", "exhausted")).status).toBe(429);
        expect(yield* owner.exec(counts)).toEqual([{ media: 2, review: 2, audit: 2, units: 2 }]);
        expect(yield* other.exec(counts)).toEqual([{ media: 0, review: 0, audit: 0, units: 0 }]);
      })
  );
  test.effect(
    "preserves global and per-User media capacity and rolls back a missing acceptance Audit",
    () =>
      Effect.gen(function* () {
        const { owner, deliver, grant } = yield* setup();
        yield* grant;
        yield* native(() =>
          owner.directory.exec(
            "WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2500) INSERT INTO media_capacity_slots(slot,generation,receipt,expires_at_ms,state) SELECT x,1,printf('opaque-%d',x),?,'retained' FROM n",
            owner.now + 86400000
          )
        );
        const full = yield* deliver("wamid.media-full", "photo");
        expect(full.status).toBe(429);
        expect(full.headers.get("retry-after")).toBe("1");
        yield* native(() => owner.directory.exec("DELETE FROM media_capacity_slots"));
        yield* owner.exec(
          "WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<50) INSERT INTO media_capacity_receipts(id,user_id,portfolio,message,input_digest,accepted_at_ms,expires_at_ms,due_ms,state) SELECT printf('cap-%d',x),?,'fixture',printf('cap-%d',x),'digest',?,?,?,'retained' FROM n",
          alice.user,
          owner.now,
          owner.now + 86400000,
          owner.now + 86400000
        );
        expect((yield* deliver("wamid.media-per-user", "photo")).status).toBe(429);
        yield* owner.exec("DELETE FROM media_capacity_receipts WHERE portfolio='fixture'");
        yield* owner.exec(
          "CREATE TRIGGER no_media_audit BEFORE INSERT ON audit_entries WHEN NEW.record_type='media_admission' BEGIN SELECT RAISE(IGNORE); END"
        );
        expect((yield* deliver("wamid.audit-delay", "photo")).status).toBe(503);

        const evidence =
          "SELECT (SELECT count(*) FROM media_submissions) AS media,(SELECT count(*) FROM ingestion_review_items WHERE source_kind='media') AS reviews,(SELECT count(*) FROM commercial_allowance_consumptions WHERE allowance='media_submission') AS charges";

        expect(yield* owner.exec(evidence)).toEqual([{ media: 0, reviews: 0, charges: 0 }]);
        yield* owner.exec("DROP TRIGGER no_media_audit");
        expect((yield* deliver("wamid.audit-delay", "photo")).status).toBe(202);
        expect(yield* owner.exec(evidence)).toEqual([{ media: 1, reviews: 1, charges: 1 }]);
      })
  );
  test.effect(
    "replies once to a signed unusable voice message and bounds five refusals in the original User hour without opening a Turn",
    () =>
      Effect.gen(function* () {
        const { owner, other, deliver, grant } = yield* setup();
        expect((yield* deliver("wamid.voice1")).status).toBe(429);
        yield* grant;

        yield* Effect.forEach(
          [
            "wamid.voice1",
            "wamid.voice1",
            "wamid.voice2",
            "wamid.voice3",
            "wamid.voice4",
            "wamid.voice5",
          ],
          Effect.fnUntraced(function* (message) {
            expect((yield* deliver(message)).status).toBe(200);
          }),
          { discard: true }
        );

        expect((yield* deliver("wamid.voice6")).status).toBe(429);

        const count =
          "SELECT (SELECT count(*) FROM whatsapp_voice_refusals WHERE outcome='accepted') AS refusals,(SELECT count(*) FROM hosted_turns) AS turns";

        expect(yield* owner.exec(count)).toEqual([{ refusals: 5, turns: 0 }]);
        expect(yield* other.exec(count)).toEqual([{ refusals: 0, turns: 0 }]);
        yield* owner.exec(
          "UPDATE whatsapp_voice_refusals SET outcome='started' WHERE message='wamid.voice1'"
        );
        expect((yield* deliver("wamid.voice1")).status).toBe(503);
        expect(
          yield* owner.exec(
            "SELECT outcome FROM whatsapp_voice_refusals WHERE message='wamid.voice1'"
          )
        ).toEqual([{ outcome: "started" }]);
      })
  );
  test.effect("keeps a failed provider voice reply terminal under an exact signed replay", () =>
    Effect.gen(function* () {
      const { grant, deliver, owner, other } = yield* setup("CO.FailedVoice");
      yield* grant;
      const stored = "SELECT outcome FROM whatsapp_voice_refusals WHERE message='wamid.failed'";
      expect((yield* deliver("wamid.failed")).status).toBe(503);
      expect(yield* owner.exec(stored)).toEqual([{ outcome: "failed" }]);
      yield* owner.exec(
        "CREATE TRIGGER no_retry BEFORE UPDATE ON whatsapp_voice_refusals BEGIN SELECT RAISE(ABORT,'unexpected retry'); END"
      );
      expect((yield* deliver("wamid.failed")).status).toBe(503);
      expect(yield* owner.exec(stored)).toEqual([{ outcome: "failed" }]);
      expect(yield* other.exec(stored)).toEqual([]);
    })
  );
});
