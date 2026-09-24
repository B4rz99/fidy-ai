import { expect, it } from "vitest";
import { Effect, Option } from "effect";
import { verifiedWompiEventHint } from "./wompi-event";

const secret = "prod_events_OcHnIzeBl5socpwByQ4hA52Em3USQ93Z";
// SHA-256 of the ordered Wompi example values, timestamp and separate events secret.
const checksum = "5A18EC5E8FDB7DF463E9F94774CBA8F583BA21BD04A09CEFF2EA68A4BC0AEFBE";
const event = {
  event: "transaction.updated",
  environment: "prod",
  data: {
    transaction: { id: "1234-1610641025-49201", status: "APPROVED", amount_in_cents: 4490000 },
  },
  signature: {
    properties: ["transaction.id", "transaction.status", "transaction.amount_in_cents"],
    checksum,
  },
  timestamp: 1530291411,
};
const request = (body: unknown, header = checksum): Request =>
  new Request("https://example.test/providers/wompi/billing-events", {
    method: "POST",
    headers: { "content-type": "application/json", "x-event-checksum": header },
    body: JSON.stringify(body),
  });
const verify = (
  body: unknown,
  header = checksum
): Promise<Option.Option<Readonly<{ transactionId: string; signedAt: number }>>> =>
  Effect.runPromise(
    verifiedWompiEventHint({ request: request(body, header), secret, environment: "production" })
  );

it("authenticates an independently calculated ordered-property Wompi event vector", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(yield* Effect.promise(() => verify(event))).toEqual(
        Option.some({ transactionId: event.data.transaction.id, signedAt: event.timestamp })
      );
    })
  ));

it("rejects changed status, forged checksum, unsigned ids and a different provider environment", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(
        yield* Effect.promise(() =>
          verify({
            ...event,
            data: { transaction: { ...event.data.transaction, status: "DECLINED" } },
          })
        )
      ).toEqual(Option.none());
      expect(yield* Effect.promise(() => verify(event, "0".repeat(checksum.length)))).toEqual(
        Option.none()
      );
      expect(
        yield* Effect.promise(() =>
          verify({
            ...event,
            signature: { ...event.signature, properties: ["transaction.status"] },
          })
        )
      ).toEqual(Option.none());
      expect(yield* Effect.promise(() => verify({ ...event, environment: "test" }))).toEqual(
        Option.none()
      );
    })
  ));
