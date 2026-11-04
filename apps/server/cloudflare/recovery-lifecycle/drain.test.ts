import { it } from "@effect/vitest";
import { Clock, Effect, Option, Schema } from "effect";
import { afterAll, expect } from "vitest";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { recoverPendingDisclosures } from "../consent/ingress/runtime";
import { observeRecoveryDrain } from "./operations";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());

it.effect(
  "observes pre-User disclosure work without treating expiry or provider acceptance as a new send",
  () =>
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() => installTestSchema({ db }));
      const empty = yield* observeRecoveryDrain({ db });
      expect(empty.pending).toBe(0);
      expect(empty.ambiguous).toBe(0);
      yield* Effect.tryPromise(() =>
        db
          .prepare(`INSERT INTO pending_consent_exchanges(
      id,portfolio_id,bsuid,phone_number_id,initiating_message_id,initiating_body_sha256,
      correlation_token,disclosure_json,created_at_ms,expires_at_ms,state
    ) VALUES('pre-user','portfolio','scoped','phone','message',?,'10000000-0000-4000-8000-000000000001','{}',0,86400000,'awaiting_delivery')`)
          .bind("0".repeat(64))
          .run()
      );
      const queued = yield* observeRecoveryDrain({ db });
      expect(queued.pending).toBe(1);
      expect(queued.owners.consentIngress.pending).toBe(1);
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE pending_consent_exchanges SET state='outbound_started' WHERE id='pre-user'"
          )
          .run()
      );
      const unknown = yield* observeRecoveryDrain({ db });
      expect(unknown.ambiguous).toBe(1);
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE pending_consent_exchanges SET disclosure_message_id='known-provider-message' WHERE id='pre-user'"
          )
          .run()
      );
      const known = yield* observeRecoveryDrain({ db });
      expect(known.pending).toBe(0);
      expect(known.ambiguous).toBe(0);
      expect(known.owners.consentIngress.preservedBlocked).toBe(1);
    })
);

it.effect("missing source-owner evidence is unavailable rather than an empty drain proof", () =>
  Effect.gen(function* () {
    const db = yield* Effect.tryPromise(() => databases.acquire());
    expect((yield* observeRecoveryDrain({ db }).pipe(Effect.exit))._tag).toBe("Failure");
  })
);

it.effect(
  "replaying a retained accepted disclosure into another target never authorizes another send",
  () =>
    Effect.gen(function* () {
      const source = yield* Effect.tryPromise(() => databases.acquire());
      const target = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() => installTestSchema({ db: source }));
      yield* Effect.tryPromise(() => installTestSchema({ db: target }));
      const current = yield* Clock.currentTimeMillis;
      yield* Effect.tryPromise(() =>
        source
          .prepare(`INSERT INTO pending_consent_exchanges(
      id,portfolio_id,bsuid,phone_number_id,initiating_message_id,initiating_body_sha256,
      correlation_token,disclosure_json,created_at_ms,expires_at_ms,state,disclosure_message_id
    ) VALUES('preserved','portfolio','scoped','phone','message',?,'10000000-0000-4000-8000-000000000002','{}',?,?,'outbound_started','original-provider-message')`)
          .bind("0".repeat(64), current, current + 86400000)
          .run()
      );
      const standing = yield* observeRecoveryDrain({ db: source });
      expect(standing.owners.consentIngress).toEqual({
        pending: 0,
        ambiguous: 0,
        preservedBlocked: 1,
      });
      const retained = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          id: Schema.String,
          portfolio_id: Schema.String,
          bsuid: Schema.String,
          phone_number_id: Schema.String,
          initiating_message_id: Schema.String,
          initiating_body_sha256: Schema.String,
          correlation_token: Schema.String,
          disclosure_json: Schema.String,
          created_at_ms: Schema.Int,
          expires_at_ms: Schema.Int,
          state: Schema.Literal("outbound_started"),
          disclosure_message_id: Schema.String,
        })
      )(
        yield* Effect.tryPromise(() =>
          source.prepare("SELECT * FROM pending_consent_exchanges WHERE id='preserved'").first()
        )
      );
      yield* Effect.tryPromise(() =>
        target
          .prepare(`INSERT INTO pending_consent_exchanges(
      id,portfolio_id,bsuid,phone_number_id,initiating_message_id,initiating_body_sha256,
      correlation_token,disclosure_json,created_at_ms,expires_at_ms,state,disclosure_message_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(...Object.values(retained))
          .run()
      );
      // A candidate awaiting_delivery would require provider authority and fail this call.
      // The retained outbound claim is excluded even while its deadline remains live.
      yield* recoverPendingDisclosures({
        db: target,
        apiKey: "",
        sandboxPhoneNumberId: Option.none(),
      });
      expect((yield* observeRecoveryDrain({ db: target })).owners.consentIngress).toEqual(
        standing.owners.consentIngress
      );
      expect(
        yield* Effect.tryPromise(() =>
          target
            .prepare(
              "SELECT state,disclosure_message_id FROM pending_consent_exchanges WHERE id='preserved'"
            )
            .first()
        )
      ).toEqual({ state: "outbound_started", disclosure_message_id: "original-provider-message" });
    })
);
