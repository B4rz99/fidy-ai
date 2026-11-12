import { type Cause, Clock, Effect, Schema } from "effect";
import { expect } from "vitest";
import { ErasureOperatorReceipt } from "../../src/core/erasure/contract";

type CustodyFixture = Readonly<{
  db: D1Database;
  userId: string;
  reference: string;
  send: (command: unknown) => Effect.Effect<Response, Schema.SchemaError | Cause.UnknownError>;
  coordinator: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
}>;
const acceptedStatus = 202;
const conflictStatus = 409;
const unavailableStatus = 503;
const okStatus = 200;
const admissionLifetimeMs = 5000;
const matureRecoveryDays = 31;
const previousRecoveryDays = 32;
const dayMs = 86400000;
const matureRecoveryMs = matureRecoveryDays * dayMs;
const previousRecoveryMs = previousRecoveryDays * dayMs;
const evidence = (
  input: CustodyFixture,
  custodian: string,
  detail: Readonly<{ suffix: string; status: string }>
): Readonly<{
  reference: string;
  custodian: string;
  evidenceRef: string;
  outcome: Readonly<{ status: string }>;
}> => ({
  reference: input.reference,
  custodian,
  evidenceRef: `12740000-0000-4000-8000-000000000${detail.suffix}`,
  outcome: { status: detail.status },
});
const submit = (
  input: CustodyFixture,
  value: unknown
): Effect.Effect<Response, Schema.SchemaError | Cause.UnknownError> =>
  input.send({ action: "CustodyEvidence", userId: input.userId, evidence: value });
const receipt = (
  input: CustodyFixture
): Effect.Effect<typeof ErasureOperatorReceipt.Type, Schema.SchemaError | Cause.UnknownError> =>
  Effect.gen(function* () {
    const response = yield* input.send({
      action: "Receipt",
      userId: input.userId,
      reference: input.reference,
    });
    expect(response.status).toBe(okStatus);
    return yield* Schema.decodeUnknownEffect(ErasureOperatorReceipt)(
      yield* Effect.tryPromise(() => response.json())
    );
  });

const eventIdentity = (
  input: CustodyFixture,
  id: string
): Effect.Effect<unknown, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    input.db
      .prepare("SELECT id FROM erasure_custody_records WHERE record_type='event' AND id=?")
      .bind(id)
      .first("id")
  );

/** Native persistence evidence: event identity is replayable, not a consumable authority. */
export const verifyCustodyRetention = Effect.fn(function* (input: CustodyFixture) {
  const accepted = evidence(input, "Kapso", { suffix: "080", status: "Accepted" });
  expect((yield* submit(input, accepted)).status).toBe(acceptedStatus);
  const original = yield* Effect.tryPromise(() =>
    input.db
      .prepare(
        "SELECT recorded_at_ms,operator_ref,evidence_json FROM erasure_custody_records WHERE record_type='event' AND id=?"
      )
      .bind(accepted.evidenceRef)
      .first()
  );
  const current = yield* Clock.currentTimeMillis;
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    userId: input.userId,
    reference: input.reference,
    deadlineMs: current + admissionLifetimeMs,
    authority: {
      permission: "titular.erase",
      operatorRef: "different-operator",
      expiresAtMs: current + admissionLifetimeMs,
    },
    evidence: accepted,
  });
  expect(
    (yield* Effect.tryPromise(() =>
      input.coordinator.getByName(input.userId).fetch(
        new Request("https://coordinator.internal/erasure-custody-evidence", {
          method: "POST",
          body,
        })
      )
    )).status
  ).toBe(acceptedStatus);
  expect(
    yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          "SELECT recorded_at_ms,operator_ref,evidence_json FROM erasure_custody_records WHERE record_type='event' AND id=?"
        )
        .bind(accepted.evidenceRef)
        .first()
    )
  ).toEqual(original);
  expect((yield* submit(input, { ...accepted, outcome: { status: "Verified" } })).status).toBe(
    conflictStatus
  );
  expect((yield* receipt(input)).custodians).toContainEqual({
    custodian: "Kapso",
    status: "Accepted",
  });

  yield* verifyTerminalProjections(input);
});

const verifyTerminalProjections = Effect.fn(function* (input: CustodyFixture) {
  // Verified can be submitted directly, and a different event cannot replace it.
  const verified = evidence(input, "Meta", { suffix: "081", status: "Verified" });
  expect((yield* submit(input, verified)).status).toBe(acceptedStatus);
  const conflicting = evidence(input, "Meta", { suffix: "082", status: "Accepted" });
  expect((yield* submit(input, conflicting)).status).toBe(conflictStatus);
  expect(yield* eventIdentity(input, conflicting.evidenceRef)).toBe(conflicting.evidenceRef);
  expect((yield* receipt(input)).custodians).toContainEqual({
    custodian: "Meta",
    status: "Verified",
  });
  expect((yield* submit(input, verified)).status).toBe(acceptedStatus);
  const notApplicable = evidence(input, "Resend", { suffix: "085", status: "NotApplicable" });
  expect((yield* submit(input, notApplicable)).status).toBe(acceptedStatus);
  expect(
    (yield* submit(input, evidence(input, "Resend", { suffix: "086", status: "Verified" }))).status
  ).toBe(conflictStatus);
  const observed = yield* receipt(input);
  expect(observed.state).toBe("ExternalPending");
  expect(observed.custodians).toContainEqual({ custodian: "Resend", status: "NotApplicable" });
});

/** Completion remains owned by continuation, with exact coverage and the latest local recovery horizon. */
const verifyCloudflareReset = Effect.fn(function* (input: CustodyFixture) {
  expect(
    (yield* submit(
      input,
      evidence(input, "Cloudflare", { suffix: "087", status: "NotApplicable" })
    )).status
  ).toBe(conflictStatus);
  const cloudflare = evidence(input, "Cloudflare", { suffix: "088", status: "Verified" });
  expect((yield* submit(input, cloudflare)).status).toBe(conflictStatus);
  const current = yield* Clock.currentTimeMillis;
  yield* Effect.tryPromise(() =>
    input.db
      .prepare("UPDATE erasure_requests SET last_erased_at_ms=? WHERE id=?")
      .bind(current - matureRecoveryMs, input.reference)
      .run()
  );
  expect((yield* submit(input, cloudflare)).status).toBe(acceptedStatus);
  // Re-run local erasure through its owner. The historical event remains, but its
  // original timestamp cannot establish the current Cloudflare projection again.
  yield* Effect.tryPromise(() =>
    input.db
      .prepare("UPDATE erasure_requests SET state='Erasing' WHERE id=?")
      .bind(input.reference)
      .run()
  );
  expect(
    (yield* input.send({ action: "Continue", userId: input.userId, reference: input.reference }))
      .status
  ).toBe(acceptedStatus);
  expect((yield* receipt(input)).custodians).toContainEqual({
    custodian: "Cloudflare",
    status: "Pending",
  });
  yield* Effect.tryPromise(() =>
    input.db
      .prepare("UPDATE erasure_requests SET last_erased_at_ms=? WHERE id=?")
      .bind(current - matureRecoveryMs, input.reference)
      .run()
  );
  expect(yield* eventIdentity(input, cloudflare.evidenceRef)).toBe(cloudflare.evidenceRef);
  // Put the retained event before this newer local erasure while keeping the horizon mature.
  yield* Effect.tryPromise(() =>
    input.db
      .prepare(
        "UPDATE erasure_custody_records SET recorded_at_ms=? WHERE record_type='event' AND id=?"
      )
      .bind(current - previousRecoveryMs, cloudflare.evidenceRef)
      .run()
  );
  expect((yield* submit(input, cloudflare)).status).toBe(conflictStatus);
  expect((yield* receipt(input)).custodians).toContainEqual({
    custodian: "Cloudflare",
    status: "Pending",
  });
  expect(
    (yield* submit(input, evidence(input, "Cloudflare", { suffix: "089", status: "Verified" })))
      .status
  ).toBe(acceptedStatus);
});

export const verifyCustodyCompletion = Effect.fn(function* (input: CustodyFixture) {
  yield* verifyCloudflareReset(input);
  for (const [custodian, suffix] of [
    ["Kapso", "090"],
    ["Meta", "091"],
    ["Resend", "092"],
    ["Wompi", "093"],
  ] as const) {
    expect(
      (yield* submit(input, evidence(input, custodian, { suffix, status: "Verified" }))).status
    ).toBe(acceptedStatus);
  }
  expect((yield* receipt(input)).state).toBe("ExternalPending");
  yield* Effect.tryPromise(() =>
    input.db
      .prepare(
        "DELETE FROM erasure_custody_records WHERE record_type='current' AND request_id=? AND custodian='Wompi'"
      )
      .bind(input.reference)
      .run()
  );
  expect(
    (yield* input.send({ action: "Continue", userId: input.userId, reference: input.reference }))
      .status
  ).toBe(acceptedStatus);
  expect((yield* receipt(input)).state).toBe("ExternalPending");
  yield* Effect.tryPromise(() =>
    input.db
      .prepare(
        "INSERT INTO erasure_custody_records(record_type,request_id,custodian,state,current_event_id) VALUES('current',?,'Wompi','Verified',?)"
      )
      .bind(input.reference, "12740000-0000-4000-8000-000000000093")
      .run()
  );
  expect(
    (yield* input.send({ action: "Continue", userId: input.userId, reference: input.reference }))
      .status
  ).toBe(acceptedStatus);
  expect((yield* receipt(input)).state).toBe("Complete");
  // A missing/non-pending request retains the existing unavailable distinction.
  const unavailable = yield* submit(
    input,
    evidence(input, "Cloudflare", { suffix: "088", status: "Verified" })
  );
  expect(unavailable.status).toBe(unavailableStatus);
  expect(unavailable.headers.get("cache-control")).toBe("no-store");
});
