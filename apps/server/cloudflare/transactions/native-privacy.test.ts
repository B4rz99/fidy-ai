import { it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import type { Miniflare } from "miniflare";
import { expect } from "vitest";
import {
  PrivacyTransactionCursor,
  PrivacyTransactionPage,
} from "../../src/shell/processing-consent/contract";
import { alice, bob, category, seed, transaction } from "../financial-user-store.test-fixture";
import { native, nativeBrowserPlatform } from "../user-store.test-fixture";
import { browserOrigins } from "../runtime/contract";

const privacyRequest = Effect.fnUntraced(function* (
  runtime: Miniflare,
  cursor: unknown,
  headers: Record<string, string> = {}
) {
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ cursor });

  const response = yield* native(() =>
    runtime.dispatchFetch("https://api.fidyapp.com/web/privacy/transactions", {
      method: "POST",
      headers: {
        origin: browserOrigins.production,
        connection: "close",
        "content-type": "application/json",
        "fidy-session-binding": alice.session,
        cookie: "__Host-fidy_session=" + alice.bearer,
        ...headers,
      },
      body,
    })
  );

  const data = yield* native(() => response.arrayBuffer());

  return new Response(data, { status: response.status });
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "returns each scoped privacy page with fresh same-User proof and atomic Audit after withdrawal",
    () =>
      Effect.gen(function* () {
        const runtime = yield* (yield* nativeBrowserPlatform)();
        const owner = yield* seed(runtime, alice, false);
        yield* seed(runtime, bob, true);
        yield* owner.exec(
          "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES('withdrawal',?,'processing_withdrawal',?)",
          alice.user,
          owner.now
        );
        yield* owner.exec(
          "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<101) INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) SELECT printf('22550000-0000-4000-8000-%012d',i),?,'25','USD','outflow',?,1700000000000+i,1700000000000+i FROM n",
          alice.user,
          category
        );
        expect(
          (yield* privacyRequest(runtime, null, { "fidy-session-binding": bob.session })).status
        ).toBe(401);
        expect(
          (yield* privacyRequest(runtime, null, { origin: "https://example.test" })).status
        ).toBe(403);
        expect(
          (yield* privacyRequest(runtime, null, { authorization: "Bearer fixture", cookie: "" }))
            .status
        ).toBe(401);
        const first = yield* privacyRequest(runtime, null);
        expect(first.status).toBe(200);

        const page = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PrivacyTransactionPage))(
          yield* native(() => first.json())
        );

        expect(page.data).toHaveLength(100);
        expect(page.next).not.toBeNull();

        const cursor = yield* Schema.encodeEffect(
          Schema.toCodecJson(Schema.NullOr(PrivacyTransactionCursor))
        )(page.next);

        const peer = yield* privacyRequest(runtime, cursor, {
          cookie: "__Host-fidy_session=" + bob.bearer,
          "fidy-session-binding": bob.session,
        });

        expect(peer.status).toBe(200);

        const peerPage = yield* Schema.decodeUnknownEffect(PrivacyTransactionPage)(
          yield* native(() => peer.json())
        );

        expect(peerPage.data.map(({ id }) => id)).toEqual([transaction]);
        const second = yield* privacyRequest(runtime, cursor);

        const final = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PrivacyTransactionPage))(
          yield* native(() => second.json())
        );

        expect(final.data).toHaveLength(1);
        expect([...page.data, ...final.data].map((record) => record.id)).not.toContain(transaction);
        expect(final.next).toBeNull();
        expect(page.reference).not.toBe(final.reference);

        const audits = yield* owner.exec(
          "SELECT id FROM audit_entries WHERE user_id=? AND session_id=? AND operation='privacy.transactions' ORDER BY rowid",
          alice.user,
          alice.session
        );

        expect(audits).toEqual([{ id: page.reference }, { id: final.reference }]);
        yield* owner.exec(
          "CREATE TRIGGER reject_privacy_audit BEFORE INSERT ON audit_entries WHEN NEW.operation='privacy.transactions' BEGIN SELECT RAISE(ABORT,'fixture'); END"
        );
        expect((yield* privacyRequest(runtime, cursor)).status).toBe(503);
        yield* owner.exec(
          "UPDATE web_sessions SET created_at_ms=created_at_ms-1200000,fresh_until_ms=fresh_until_ms-1200000,idle_expires_at_ms=idle_expires_at_ms-1200000,hard_expires_at_ms=hard_expires_at_ms-1200000 WHERE id=?",
          alice.session
        );
        expect((yield* privacyRequest(runtime, cursor)).status).toBe(401);
      })
  );
});
