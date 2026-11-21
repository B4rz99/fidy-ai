import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Data, Effect, Schema } from "effect";
import { expect } from "vitest";
import { alice, makeNativeTransactionJourney } from "../financial-user-store.test-fixture";
import { native } from "../user-store.test-fixture";
import { type ReviewCommand } from "../../src/core/ingestion/contract";

const ReviewWire = Data.taggedEnum<typeof ReviewCommand.Encoded>();

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("reads fresh Needs Review counts and bounded pages from the authenticated User", () =>
    Effect.gen(function* () {
      const journey = yield* makeNativeTransactionJourney();
      const page = yield* native(() => journey.browser(0, "/ingestion/review-workspace?limit=0"));
      expect(page.status).toBe(200);
      expect(yield* native(() => page.json())).toMatchObject({
        data: { pendingCount: 0, total: 0, items: [] },
      });
      expect(
        yield* native(() =>
          journey.exec(
            "SELECT count(*) AS n FROM audit_entries WHERE user_id=? AND operation='ingestion.getReviewWorkspace'",
            alice.user
          )
        )
      ).toEqual([{ n: 1 }]);
    })
  );
  test.effect("settles a revision-bound review once and keeps foreign material private", () =>
    Effect.gen(function* () {
      const journey = yield* makeNativeTransactionJourney();
      const id = "20000000-0000-4000-8000-000000000001";
      const now = yield* Clock.currentTimeMillis;
      yield* native(() =>
        journey.exec(
          "INSERT INTO forwarded_email_receipts(id,user_id,received_at_ms,expires_at_ms) VALUES (?,?,?,?)",
          id,
          alice.user,
          now,
          now + 60000
        )
      );
      yield* native(() =>
        journey.exec(
          "INSERT INTO ingestion_review_items(id,user_id,source_kind,email_receipt_id,reason,created_at_ms,evidence_expires_at_ms,service_market,locale,time_zone) VALUES (?,?,'email',?,'unknown-format',?,?,'CO','es-CO','America/Bogota')",
          id,
          alice.user,
          id,
          now,
          now + 60000
        )
      );

      const edit = (payload: unknown): Effect.Effect<Response> =>
        native(() =>
          journey.send(
            new Request("https://api.fidyapp.com/ingestion/review-workspace/edits", {
              method: "POST",
              headers: {
                origin: "https://app.fidyapp.com",
                cookie: "__Host-fidy_session=" + alice.bearer,
                "Fidy-Session-Binding": alice.session,
                "content-type": "application/json",
              },
              body: JSON.stringify(payload),
            })
          )
        );

      expect(
        (yield* native(() => journey.browser(1, "/ingestion/review-workspace/" + id))).status
      ).toBe(404);
      const skip = ReviewWire.Skip({ items: [{ id, revision: 0 }] });
      const skipped = yield* edit(skip);
      expect(skipped.status).toBe(200);
      expect(yield* native(() => skipped.json())).toMatchObject({
        data: [{ item: { id, status: "skipped" }, revision: 1 }],
      });
      expect((yield* edit(skip)).status).toBe(400);

      const history = yield* native(() =>
        journey.browser(0, "/ingestion/review-workspace?status=history&limit=1")
      );

      expect(yield* native(() => history.json())).toMatchObject({
        data: { pendingCount: 0, total: 1, selectedDetail: { revision: 1 } },
      });
      expect((yield* edit(ReviewWire.Restore({ items: [{ id, revision: 1 }] }))).status).toBe(200);

      const command = ReviewWire.Create({
        id,
        revision: 2,
        extraction: {
          money: { amount: "8.50", currency: "USD" },
          occurredAt: "2025-11-01T18:00:00.000Z",
          direction: "outflow",
        },
      });

      const created = yield* edit(command);
      expect(created.status).toBe(200);
      expect(yield* native(() => created.json())).toMatchObject({
        data: [{ item: { status: "created" }, revision: 3 }],
      });
      expect((yield* edit(command)).status).toBe(400);
      const detail = yield* native(() => journey.browser(0, "/ingestion/review-workspace/" + id));

      const recovered = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          data: Schema.Struct({ item: Schema.Struct({ transactionId: Schema.String }) }),
        })
      )(yield* native(() => detail.json()));

      const transaction = yield* native(() =>
        journey.browser(0, "/transactions/" + recovered.data.item.transactionId)
      );

      expect(yield* native(() => transaction.json())).toMatchObject({
        data: { money: { amount: "8.5", currency: "USD" } },
      });
      expect(
        yield* native(() =>
          journey.exec(
            "SELECT kind,interpretation_revision,review_item_id FROM source_attestations WHERE user_id=?",
            alice.user
          )
        )
      ).toEqual([
        { kind: "manual", interpretation_revision: "user-reviewed-v1", review_item_id: id },
      ]);
    })
  );
});
