import { it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { DisclosureSnapshot } from "../../src/core/consent/contract";
import { webSignupDisclosure } from "../../src/shell/consent/operations";
import { ProcessingConsentStatus } from "../../src/shell/processing-consent/contract";
import {
  alice,
  bob,
  nativeBrowserWrite,
  nativeTransactionJourney,
} from "../financial-user-store.test-fixture";
import { native } from "../user-store.test-fixture";

const statusBody = (response: Response): Effect.Effect<unknown> => native(() => response.json());

const grant = "80000000-0000-4000-8000-000000000001";

const grantConsent = Effect.fn(function* (
  journey: Effect.Success<typeof nativeTransactionJourney>,
  user: typeof alice,
  encoded: string
) {
  yield* native(() =>
    journey
      .owner(user.user)
      .exec(
        "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms,disclosure_json) VALUES (?,?,'processing_grant',0,?)",
        grant,
        user.user,
        encoded
      )
  );
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "withdraws one User's live Consent once and renews only its exact reviewed disclosure with fresh browser proof",
    () =>
      Effect.gen(function* () {
        const journey = yield* nativeTransactionJourney;
        const disclosure = webSignupDisclosure();

        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(DisclosureSnapshot))(
          disclosure
        );

        yield* Effect.forEach([alice, bob], (user) => grantConsent(journey, user, encoded), {
          discard: true,
        });

        const call = nativeBrowserWrite(journey);

        const receipts = yield* Effect.forEach(
          [0, 1],
          () =>
            call(alice, {
              path: "/web/consent/withdraw",
              method: "POST",
              body: { confirm: true },
            }).pipe(
              Effect.flatMap(statusBody),
              Effect.flatMap(Schema.decodeUnknownEffect(ProcessingConsentStatus))
            ),
          { concurrency: 2 }
        );

        expect(receipts[0]).toEqual(receipts[1]);
        const receipt = receipts[0];

        if (receipt?.status !== "Revoked") throw new Error("Missing withdrawal receipt");
        expect(
          yield* native(() =>
            journey.exec(
              "SELECT count(*) AS n FROM audit_entries WHERE operation='consent.withdraw'"
            )
          )
        ).toEqual([{ n: 1 }]);
        expect((yield* native(() => journey.browser(0))).status).toBe(401);
        expect((yield* native(() => journey.browser(1))).status).toBe(200);

        const body = {
          confirm: true,
          withdrawalReference: receipt.withdrawal.reference,
          authorizationReference: grant,
          disclosureSha256: disclosure.contentSha256,
        };

        expect(
          (yield* call(bob, { path: "/web/consent/renew", method: "POST", body })).status
        ).toBe(403);
        expect(
          (yield* call(alice, {
            path: "/web/consent/renew",
            method: "POST",
            body: { ...body, disclosureSha256: "0".repeat(64) },
          })).status
        ).toBe(403);

        const restore = (): Effect.Effect<Response> =>
          call(alice, { path: "/web/consent/renew", method: "POST", body });

        const accepted = yield* restore();
        expect(accepted.status).toBe(200);
        const replay = yield* restore();
        expect(yield* native(() => replay.json())).toEqual(yield* native(() => accepted.json()));
        expect((yield* native(() => journey.browser(0))).status).toBe(200);
      })
  );
});
