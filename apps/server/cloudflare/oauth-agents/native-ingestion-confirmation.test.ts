import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Data, Effect, Schema } from "effect";
import { expect } from "vitest";
import { nativeGrant, protocolFor } from "./native-grant.test-fixture";
import { native } from "../user-store.test-fixture";
import { alice } from "../financial-user-store.test-fixture";
import type { ReviewCommand } from "../../src/core/ingestion/contract";

const ReviewWire = Data.taggedEnum<typeof ReviewCommand.Encoded>();

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "binds an OAuth review edit to its exact revision and confirms through the User owner",
    () =>
      Effect.gen(function* () {
        const { owner, runtime, credential } = yield* nativeGrant,
          id = "30000000-0000-4000-8000-000000000041";

        yield* owner.exec(
          "INSERT INTO forwarded_email_receipts(id,user_id,received_at_ms,expires_at_ms) VALUES(?,?,?,?)",
          id,
          alice.user,
          owner.now,
          owner.now + 86400000
        );
        yield* owner.exec(
          "INSERT INTO ingestion_review_items(id,user_id,source_kind,email_receipt_id,reason,created_at_ms,evidence_expires_at_ms,service_market,locale,time_zone) VALUES(?,?,'email',?,'unknown-format',?,?,'CO','es-CO','America/Bogota')",
          id,
          alice.user,
          id,
          owner.now,
          owner.now + 86400000
        );
        const protocol = protocolFor(runtime);

        const invoke = (revision: number, state?: string): ReturnType<typeof protocol> =>
          protocol(credential.access_token, "tools/call", {
            name: "ingestion.applyReviewEdit",
            args: { payload: ReviewWire.Skip({ items: [{ id, revision }] }) },
            continuation: state,
          });

        const form = Schema.Struct({
          result: Schema.Struct({
            requestState: Schema.String,
            inputRequests: Schema.Struct({
              review: Schema.Struct({ params: Schema.Struct({ message: Schema.String }) }),
            }),
          }),
        });

        const first = yield* invoke(0),
          snapshot = yield* Schema.decodeUnknownEffect(form)(yield* native(() => first.json()));

        expect(snapshot.result.inputRequests.review.params.message).toContain(id);
        yield* owner.exec(
          "UPDATE ingestion_review_items SET workspace_state='pending',workspace_revision=1,workspace_updated_at_ms=?,workspace_archive_row_ref='review:'||id WHERE id=?",
          owner.now,
          id
        );
        const stale = yield* invoke(0, snapshot.result.requestState);
        expect(yield* native(() => stale.json())).toMatchObject({ result: { isError: true } });

        const second = yield* invoke(1),
          fresh = yield* Schema.decodeUnknownEffect(form)(yield* native(() => second.json()));

        const submitted = yield* invoke(1, fresh.result.requestState);
        expect(yield* native(() => submitted.json())).toMatchObject({ result: { isError: false } });
        expect(
          yield* owner.exec(
            "SELECT workspace_state,workspace_revision FROM ingestion_review_items WHERE id=?",
            id
          )
        ).toEqual([{ workspace_state: "skipped", workspace_revision: 2 }]);
      })
  );

  test.effect("invalidates a confirmed statement resolution if a sibling revision changes", () =>
    Effect.gen(function* () {
      const { owner, runtime, credential } = yield* nativeGrant,
        submission = "30000000-0000-4000-8000-000000000064",
        first = "30000000-0000-4000-8000-000000000065",
        second = "30000000-0000-4000-8000-000000000066",
        deadline = owner.now + 86400000,
        sha = "a".repeat(64);

      yield* owner.exec(
        "INSERT INTO statement_staging_objects(id,user_id,object_key,byte_length,sha256,status,created_at_ms,expires_at_ms,published_submission_id,source_format) VALUES(?,?,?,24,?,'published',?,?,?,'csv')",
        submission,
        alice.user,
        "users/" + alice.user + "/staging/statement/v1/" + submission,
        sha,
        owner.now,
        deadline,
        submission
      );
      yield* owner.exec(
        "INSERT INTO statement_submissions(id,user_id,idempotency_key,staging_id,submitted_at_ms,source_format,parser_revision,service_market,locale,time_zone,status,started_at_ms,completed_at_ms,retention_expires_at_ms,clarification_state,clarification_expires_at_ms,processed_rows,processed_review_rows) VALUES(?,?,?,?,?,'csv','statement-v1','CO','es-CO','America/Bogota','completed',?,?,?,'awaiting',?,2,2)",
        submission,
        alice.user,
        submission,
        submission,
        owner.now,
        owner.now,
        owner.now,
        deadline,
        deadline
      );

      yield* Effect.forEach(
        [first, second].entries(),
        Effect.fnUntraced(function* ([index, id]) {
          yield* owner.exec(
            "INSERT INTO ingestion_review_items(id,user_id,source_kind,statement_submission_id,record_number,reason,created_at_ms,evidence_expires_at_ms,service_market,locale,time_zone,source_format,parser_revision,extractor_revision,original_evidence,issues_json,evidence_state) VALUES(?,?,'statement',?,?,'mapping-unavailable',?,?,'CO','es-CO','America/Bogota','csv','statement-v1','mechanical-v1','private-only','[]','retained')",
            id,
            alice.user,
            submission,
            index + 1,
            owner.now,
            deadline
          );
        }),
        { discard: true }
      );

      const protocol = protocolFor(runtime);

      const call = (state?: string): ReturnType<typeof protocol> =>
        protocol(credential.access_token, "tools/call", {
          name: "ingestion.resolveNeedsReviewItem",
          args: {
            params: { id: first },
            payload: {
              extraction: {
                direction: "outflow",
                money: { amount: "4200", currency: "COP" },
                occurredAt: "2025-11-01T12:00:00.000Z",
              },
            },
          },
          continuation: state,
        });

      const form = Schema.Struct({
        result: Schema.Struct({
          requestState: Schema.String,
          inputRequests: Schema.Struct({
            review: Schema.Struct({ params: Schema.Struct({ message: Schema.String }) }),
          }),
        }),
      });

      const request = yield* call();

      const firstForm = yield* Schema.decodeUnknownEffect(form)(
        yield* native(() => request.json())
      );

      expect(firstForm.result.inputRequests.review.params.message).toContain(first);
      expect(firstForm.result.inputRequests.review.params.message).not.toContain("private-only");
      yield* owner.exec(
        "UPDATE ingestion_review_items SET workspace_revision=1,workspace_state='pending',workspace_updated_at_ms=?,workspace_archive_row_ref='review:'||id WHERE id=?",
        owner.now,
        second
      );
      const stale = yield* call(firstForm.result.requestState);
      expect(yield* native(() => stale.json())).toMatchObject({ result: { isError: true } });
      expect(yield* owner.exec("SELECT count(*) AS n FROM source_attestations")).toEqual([
        { n: 0 },
      ]);
      const next = yield* call();
      const fresh = yield* Schema.decodeUnknownEffect(form)(yield* native(() => next.json()));
      const confirmed = yield* call(fresh.result.requestState);
      expect(yield* native(() => confirmed.json())).toMatchObject({ result: { isError: false } });
      expect(yield* owner.exec("SELECT statement_submission_id FROM source_attestations")).toEqual([
        { statement_submission_id: submission },
      ]);
    })
  );
});
