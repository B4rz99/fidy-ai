import assert from "node:assert/strict";
import { expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import {
  SentryEvidenceReadError,
  decodeSentryOperatorEvidence,
  readSentryOperatorEvidence,
} from "./sentry-account-evidence";

it.effect("bounds malformed private evidence diagnostics", () =>
  Effect.gen(function* () {
    const secret = "private-evidence-sentinel";
    const exit = yield* decodeSentryOperatorEvidence(`{"version":"${secret}"}`).pipe(Effect.exit);

    assert.deepStrictEqual(exit, Exit.fail(SentryEvidenceReadError.make({ reason: "invalid" })));
    expect(String(exit)).not.toContain(secret);
  })
);

it.effect("rejects oversized private evidence before reading or decoding", () =>
  Effect.gen(function* () {
    const exit = yield* readSentryOperatorEvidence(new Blob([new Uint8Array(70_000)])).pipe(
      Effect.exit
    );

    assert.deepStrictEqual(exit, Exit.fail(SentryEvidenceReadError.make({ reason: "too-large" })));
  })
);
