import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Data, Effect } from "effect";
import { expect } from "vitest";
import { native } from "../user-store.test-fixture";
import {
  alice,
  bob,
  nativeTransactionJourney,
  seedNativePAT,
} from "../financial-user-store.test-fixture";
import { batchCallId } from "./statement-batch.test-fixture";
import { type ReviewCommand, type ReviewDraft } from "../../src/core/ingestion/contract";

type ReviewEditWire =
  | typeof ReviewCommand.Encoded
  | Data.TaggedEnum<{ Reprocess: { readonly id: string; readonly revision: number } }>;

const ReviewWire = Data.taggedEnum<ReviewEditWire>();

const seedMedia = Effect.fn(function* (
  journey: Effect.Success<typeof nativeTransactionJourney>,
  user: typeof alice,
  { id, when }: { id: string; when: number }
) {
  const local = journey.owner(user.user);
  yield* native(() =>
    local.exec(
      "INSERT INTO media_submissions(id,user_id,portfolio_id,bsuid,message_id,input_digest,caption,accepted_at_ms,expires_at_ms,service_market,locale,time_zone) VALUES(?,?,'portfolio','bsuid',?,'digest','private image caption',?,?,'CO','es-CO','America/Bogota')",
      id,
      user.user,
      id,
      when,
      when + 2592000000
    )
  );
  yield* native(() =>
    local.exec(
      "INSERT INTO ingestion_review_items(id,user_id,source_kind,media_submission_id,reason,created_at_ms,evidence_expires_at_ms,service_market,locale,time_zone) VALUES(?,?,'media',?,'unparseable-material',?,?,'CO','es-CO','America/Bogota')",
      id,
      user.user,
      id,
      when,
      when + 2592000000
    )
  );
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "keeps drafts and media private across paging, revision conflicts, rollback, expiry and withdrawn credentials",
    Effect.fnUntraced(function* () {
      const journey = yield* nativeTransactionJourney,
        now = yield* Clock.currentTimeMillis,
        first = batchCallId(51),
        second = batchCallId(52),
        foreign = batchCallId(53);

      yield* seedMedia(journey, alice, { id: first, when: now });
      yield* seedMedia(journey, alice, { id: second, when: now + 1 });
      yield* seedMedia(journey, bob, { id: foreign, when: now });

      const read = (path: string, index = 0): Effect.Effect<Response> =>
        native(() => journey.browser(index, path));

      const edit = (command: unknown): Effect.Effect<Response> =>
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
              body: JSON.stringify(command),
            })
          )
        );

      const inbox = "/ingestion/review-workspace",
        item = inbox + "/" + first;

      const draft: typeof ReviewDraft.Encoded = {
        amount: "42",
        currency: "USD",
        direction: "outflow",
        counterparty: "panadería",
        occurredAt: "",
        userProvidedFields: ["money"],
      };

      expect((yield* edit(ReviewWire.SaveDraft({ id: first, revision: 0, draft }))).status).toBe(
        200
      );
      const split = yield* read(inbox + "?limit=1&offset=1");
      expect(yield* native(() => split.json())).toMatchObject({
        data: { pendingCount: 2, total: 2, items: [{ id: second }] },
      });
      expect((yield* read(inbox + "?limit=51")).status).toBe(400);
      const metadata = yield* read(inbox);
      expect(yield* native(() => metadata.text())).not.toContain("private image caption");
      const context = yield* read(inbox + "/context?limit=1");
      expect(yield* native(() => context.json())).toMatchObject({
        data: { items: [{ id: first, excerpt: "private image caption" }] },
      });
      expect((yield* read(item + "/material", 1)).status).toBe(404);
      const token = "fin_abcdefgh_" + "s".repeat(43);
      yield* seedNativePAT({
        db: journey,
        userId: alice.user,
        token,
        scopes: ["read", "write"],
        current: now,
      });

      yield* Effect.forEach(
        [item + "/material", inbox + "/context"],
        Effect.fnUntraced(function* (path) {
          const agent = yield* native(() =>
            journey.send(
              new Request("https://api.fidyapp.com" + path, {
                headers: { authorization: "Bearer " + token },
              })
            )
          );

          expect(agent.status).toBeGreaterThanOrEqual(400);
          expect(yield* native(() => agent.text())).not.toContain("private image caption");
        }),
        { discard: true }
      );

      expect(
        (yield* edit(
          ReviewWire.Skip({
            items: [
              { id: first, revision: 1 },
              { id: foreign, revision: 0 },
            ],
          })
        )).status
      ).toBe(400);

      const skip = ReviewWire.Skip({
        items: [
          { id: first, revision: 1 },
          { id: second, revision: 0 },
        ],
      });

      yield* native(() =>
        journey.exec(
          "CREATE TRIGGER lose_review_audit BEFORE INSERT ON audit_entries WHEN NEW.operation='ingestion.applyReviewEdit' BEGIN SELECT RAISE(ABORT,'fixture'); END"
        )
      );
      expect((yield* edit(skip)).status).toBe(503);
      yield* native(() => journey.exec("DROP TRIGGER lose_review_audit"));
      expect((yield* edit(skip)).status).toBe(200);
      yield* native(() => journey.exec("DELETE FROM canonical_request_buckets"));
      const detail = yield* read(item);
      expect(yield* native(() => detail.json())).toMatchObject({
        data: { revision: 2, draft, item: { id: first, status: "skipped" } },
      });
      expect(
        (yield* edit(ReviewWire.Restore({ items: [{ id: first, revision: 1 }] }))).status
      ).toBe(400);
      expect((yield* edit(ReviewWire.Reprocess({ id: first, revision: 2 }))).status).toBe(400);
      yield* native(() =>
        journey.exec(
          "UPDATE ingestion_review_items SET evidence_expires_at_ms=? WHERE id=?",
          now - 1,
          first
        )
      );
      const material = yield* read(item + "/material");
      expect(yield* native(() => material.json())).toMatchObject({
        data: { available: false, reason: "expired" },
      });
      const expired = yield* read(item);
      expect(yield* native(() => expired.text())).not.toContain("panadería");
      expect(
        (yield* edit(ReviewWire.Restore({ items: [{ id: first, revision: 2 }] }))).status
      ).toBe(400);
      const others = yield* read(inbox, 1);
      expect(yield* native(() => others.json())).toMatchObject({
        data: { pendingCount: 1, items: [{ id: foreign }] },
      });
      yield* native(() =>
        journey.exec("UPDATE web_sessions SET revoked_at_ms=? WHERE id=?", now, alice.session)
      );

      const audit = (): Effect.Effect<Awaited<ReturnType<typeof journey.exec>>> =>
        native(() =>
          journey.exec(
            "SELECT count(*) AS n FROM audit_entries WHERE operation='ingestion.getReviewItem'"
          )
        );

      const before = yield* audit();
      expect((yield* read(item)).status).toBe(401);
      expect(yield* audit()).toEqual(before);
      expect((yield* edit(skip)).status).toBe(401);
    })
  );
});
