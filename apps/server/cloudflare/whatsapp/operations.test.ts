import {
  HostedDeliveryCorrelationToken,
  WhatsAppBusinessPhoneNumberId,
} from "../../src/shell/channels/whatsapp/contract";
import { Effect, Exit, Option } from "effect";
import assert from "node:assert/strict";
import { afterAll, it } from "vitest";
import { isolatedTestDatabases } from "../d1-test-fixture";
import { WhatsAppUnavailable } from "./contract";
import { findWhatsAppDeliveryUser } from "./operations";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());

it("projects a real storage rejection into a closed channel failure without its statement or cause", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      const result = yield* Effect.exit(
        findWhatsAppDeliveryUser({
          db,
          correlationToken: HostedDeliveryCorrelationToken.make(
            "11111111-1111-4111-8111-111111111111"
          ),
          businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789"),
        })
      );
      assert.deepStrictEqual(result, Exit.fail(new WhatsAppUnavailable()));
    })
  ));

it("distinguishes an absent delivery hint from malformed retained User evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() =>
        db
          .prepare(`CREATE TABLE hosted_whatsapp_delivery (
          user_id TEXT, correlation_token TEXT, business_phone_number_id TEXT
        )`)
          .run()
      );
      const input = {
        db,
        correlationToken: HostedDeliveryCorrelationToken.make(
          "11111111-1111-4111-8111-111111111111"
        ),
        businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789"),
      };
      assert.deepStrictEqual(yield* findWhatsAppDeliveryUser(input), Option.none());
      yield* Effect.tryPromise(() =>
        db
          .prepare("INSERT INTO hosted_whatsapp_delivery VALUES (?, ?, ?)")
          .bind("malformed-user", input.correlationToken, input.businessPhoneNumberId)
          .run()
      );
      const result = yield* Effect.exit(findWhatsAppDeliveryUser(input));
      assert.deepStrictEqual(result, Exit.fail(new WhatsAppUnavailable()));
    })
  ));
