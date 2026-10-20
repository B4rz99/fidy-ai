import { Effect, Schema } from "effect";
import { expect } from "vitest";
import {
  OAuthOperationDecision,
  OAuthOperationReview,
} from "../../src/shell/oauth-agents/contract";
import { type FixtureHeaders, type TestFailure, wait } from "./oauth-ingress.test-fixture";

const okStatus = 200;
type BrowserFixture = Readonly<{
  send: (path: string, init?: RequestInit) => Promise<Response>;
  headers: FixtureHeaders;
}>;
export const readFirstPartyOperation = Effect.fn(function* (
  fixture: BrowserFixture,
  reference: string
): Effect.fn.Return<OAuthOperationReview, TestFailure | Schema.SchemaError> {
  const response = yield* wait(
    fixture.send(`/web/oauth/operation-review?reference=${reference}`, { headers: fixture.headers })
  );
  expect(response.status).toBe(okStatus);
  return yield* Schema.decodeUnknownEffect(OAuthOperationReview)(yield* wait(response.json()));
});
/** Explicit synthetic browser action; never inserted into native calls automatically. */
export const approveFirstPartyOperation = Effect.fn(function* (
  fixture: BrowserFixture,
  reference: string
): Effect.fn.Return<void, TestFailure | Schema.SchemaError> {
  const review = yield* readFirstPartyOperation(fixture, reference);
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(OAuthOperationDecision))({
    reference,
    inputDigest: review.inputDigest,
    disclosureRevision: review.disclosureRevision,
    decision: "approve",
  });
  const response = yield* wait(
    fixture.send("/web/oauth/operation-decision", {
      method: "POST",
      headers: fixture.headers,
      body,
    })
  );
  expect(response.status).toBe(okStatus);
});
