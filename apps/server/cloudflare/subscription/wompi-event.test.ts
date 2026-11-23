import type { BillingObservationWorkflow } from "./contract";
import { offerNativeBillingWork } from "./runtime";
import { receiveWompiBillingEvent } from "./internal/billing-workflow";
import { expect, it, vi } from "vitest";
import { Effect, Option } from "effect";
import { verifiedWompiEventHint } from "./internal/wompi-event";
import { WompiBillingEvent } from "./contract";

const secret = "prod_events_OcHnIzeBl5socpwByQ4hA52Em3USQ93Z";

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

const requestWithoutChecksum = (body: unknown): Request =>
  new Request("https://example.test/providers/wompi/billing-events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const verify = (
  body: unknown,
  header = checksum
): Promise<
  Option.Option<Readonly<{ transactionId: string; signedAt: number; signedStatus: string }>>
> =>
  Effect.runPromise(
    verifiedWompiEventHint({ request: request(body, header), secret, environment: "production" })
  );

it("authenticates an independently calculated ordered-property Wompi event vector", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(yield* Effect.tryPromise(() => verify(event))).toEqual(
        Option.some({
          transactionId: event.data.transaction.id,
          signedAt: event.timestamp,
          signedStatus: event.data.transaction.status,
        })
      );
    })
  ));

it("accepts a body-signed event when the checksum header is absent and rejects an empty header", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(
        yield* verifiedWompiEventHint({
          request: requestWithoutChecksum(event),
          secret,
          environment: "production",
        })
      ).toEqual(
        Option.some({
          transactionId: event.data.transaction.id,
          signedAt: event.timestamp,
          signedStatus: event.data.transaction.status,
        })
      );
      expect(yield* Effect.tryPromise(() => verify(event, ""))).toEqual(Option.none());
    })
  ));

it("rejects changed status, forged checksum, unsigned ids and a different provider environment", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(
        yield* Effect.tryPromise(() =>
          verify({
            ...event,
            data: { transaction: { ...event.data.transaction, status: "DECLINED" } },
          })
        )
      ).toEqual(Option.none());
      expect(yield* Effect.tryPromise(() => verify(event, "0".repeat(checksum.length)))).toEqual(
        Option.none()
      );
      expect(
        yield* Effect.tryPromise(() =>
          verify({
            ...event,
            signature: { ...event.signature, properties: ["transaction.status"] },
          })
        )
      ).toEqual(Option.none());
      expect(yield* Effect.tryPromise(() => verify({ ...event, environment: "test" }))).toEqual(
        Option.none()
      );
    })
  ));

it("acknowledges the signed Wompi event only after the billing Queue accepts its bounded lookup hint", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const messages: unknown[] = [];

      const ingress = (send: (value: unknown) => Promise<void>): Effect.Effect<Response> =>
        receiveWompiBillingEvent({
          request: request(event),
          environment: {
            WOMPI_ENVIRONMENT: "production",
            WOMPI_EVENT_SECRET: secret,
            BILLING_COLLECTION_QUEUE: { send },
          },
        });

      expect((yield* ingress(() => Promise.reject(new Error("queue unavailable")))).status).toBe(
        503
      );
      expect(
        (yield* ingress((value) => {
          messages.push(value);

          return Promise.resolve();
        })).status
      ).toBe(200);
      expect(messages).toEqual([
        WompiBillingEvent.make({
          environment: "production",
          transactionId: "1234-1610641025-49201",
          signedAt: 1530291411,
          signedStatus: "APPROVED",
        }),
      ]);
    })
  ));

it("acknowledges duplicate billing work only when its Workflow is active, complete, or successfully restarted", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let status: InstanceStatus["status"] = "unknown";
      const restart = vi.fn(() => Promise.resolve());

      const workflow: BillingObservationWorkflow = {
        create: () => Promise.reject(new Error("creation unavailable")),
        get: () => Promise.resolve({ status: () => Promise.resolve({ status }), restart }),
      };

      const offer = offerNativeBillingWork(
        workflow,
        WompiBillingEvent.make({
          environment: "production",
          signedStatus: "APPROVED",
          signedAt: event.timestamp,
          transactionId: event.data.transaction.id,
        })
      );

      yield* Effect.forEach(
        ["unknown", "paused", "terminated"] as const,
        Effect.fnUntraced(function* (unavailable) {
          status = unavailable;
          expect(yield* Effect.isFailure(offer)).toBe(true);
        }),
        { discard: true }
      );

      yield* Effect.forEach(
        ["queued", "running", "waiting", "complete"] as const,
        Effect.fnUntraced(function* (confirmed) {
          status = confirmed;
          expect(yield* Effect.isSuccess(offer)).toBe(true);
        }),
        { discard: true }
      );

      expect(restart).not.toHaveBeenCalled();
      status = "errored";
      restart.mockRejectedValueOnce(new Error("restart unavailable"));
      expect(yield* Effect.isFailure(offer)).toBe(true);
      expect(yield* Effect.isSuccess(offer)).toBe(true);
      expect(restart).toHaveBeenCalledTimes(2);
    })
  ));
