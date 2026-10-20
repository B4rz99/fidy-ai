import { readFirstPartyOperation } from "./oauth-first-party.test-fixture";
import {
  OAuthOperationDecision,
  OAuthOperationReview,
} from "../../src/shell/oauth-agents/contract";
import { Clock, Effect, Schema } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import {
  type NativeFixture,
  pendingBudgetDeletion,
  sessionFor,
  wait,
} from "./oauth-ingress.test-fixture";

it("refuses a destructive MCP client assertion without first-party browser approval", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* pendingBudgetDeletion();
      const response = yield* wait(fixture.call({ action: "accept", content: { confirm: true } }));
      expect(yield* wait(response.json())).toMatchObject({ result: { isError: true } });
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) AS total FROM budgets WHERE id=?")
            .bind(fixture.id)
            .first()
        )
      ).toEqual({ total: 1 });
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) AS total FROM oauth_operation_intents WHERE reference=?")
            .bind(fixture.reference)
            .first()
        )
      ).toEqual({ total: 1 });
    })
  ));

it("requires a same-User fresh browser decision and consumes it exactly once", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* pendingBudgetDeletion();
      const review = yield* wait(
        fixture.send(`/web/oauth/operation-review?reference=${fixture.reference}`, {
          headers: fixture.headers,
        })
      );
      expect(review.status).toBe(200);
      const body = yield* Schema.decodeUnknownEffect(OAuthOperationReview)(
        yield* wait(review.json())
      );
      expect(body).toMatchObject({
        reference: fixture.reference,
        operation: "budgets.deleteBudget",
        approved: false,
      });
      const decision: typeof OAuthOperationDecision.Type = {
        reference: body.reference,
        inputDigest: body.inputDigest,
        disclosureRevision: body.disclosureRevision,
        decision: "approve",
      };
      const approval = yield* wait(
        fixture.send("/web/oauth/operation-decision", {
          method: "POST",
          headers: fixture.headers,
          body: yield* Schema.encodeEffect(Schema.fromJsonString(OAuthOperationDecision))(decision),
        })
      );
      expect(approval.status).toBe(200);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) AS total FROM budgets WHERE id=?")
            .bind(fixture.id)
            .first()
        )
      ).toEqual({ total: 1 });
      expect(
        yield* wait(
          (yield* wait(fixture.call({ action: "accept", content: { confirm: true } }))).json()
        )
      ).toMatchObject({ result: { isError: false } });
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) AS total FROM budgets WHERE id=?")
            .bind(fixture.id)
            .first()
        )
      ).toEqual({ total: 0 });
      const native = yield* wait(fixture.call({ action: "accept", content: { confirm: true } }));
      if (native.status === 200) {
        expect(yield* wait(native.json())).toMatchObject({ result: { isError: true } });
      } else expect([400, 401, 403]).toContain(native.status);
    })
  ));

afterEach(() => vi.useRealTimers());
const attacks = [
  "bearer-only",
  "wrong-origin",
  "wrong-binding",
  "wrong-user",
  "stale-session",
  "revoked-grant",
  "changed-digest",
  "changed-disclosure",
  "client-approval-field",
] as const;
it.each(attacks)("refuses first-party operation approval from %s", (attack) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* pendingBudgetDeletion();
      const review = yield* readFirstPartyOperation(fixture, fixture.reference);
      const headers = new Headers(fixture.headers);
      let inputDigest = review.inputDigest;
      let disclosureRevision = review.disclosureRevision;
      yield* alterBrowserAuthority(fixture, attack, headers);
      if (attack === "changed-digest") inputDigest = "0".repeat(64);
      if (attack === "changed-disclosure") disclosureRevision = "invented";
      const choice: Schema.JsonObject = {
        reference: review.reference,
        inputDigest,
        disclosureRevision,
        decision: "approve",
        ...(attack === "client-approval-field" ? { browserApproved: true } : {}),
      };
      const response = yield* wait(
        fixture.send("/web/oauth/operation-decision", {
          method: "POST",
          headers,
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))(choice),
        })
      );
      expect([400, 401, 403]).toContain(response.status);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT browser_approved_at_ms FROM oauth_operation_intents WHERE reference = ?"
            )
            .bind(fixture.reference)
            .first()
        )
      ).toEqual({ browser_approved_at_ms: null });
      const native = yield* wait(fixture.call({ action: "accept", content: { confirm: true } }));
      if (native.status === 200) {
        expect(yield* wait(native.json())).toMatchObject({ result: { isError: true } });
      } else expect([400, 401, 403]).toContain(native.status);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) AS total FROM budgets WHERE id=?")
            .bind(fixture.id)
            .first()
        )
      ).toEqual({ total: 1 });
    })
  )
);

it("cancels a browser-reviewed operation without changes or later native authority", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* pendingBudgetDeletion();
      const review = yield* readFirstPartyOperation(fixture, fixture.reference);
      const response = yield* wait(
        fixture.send("/web/oauth/operation-decision", {
          method: "POST",
          headers: fixture.headers,
          body: yield* Schema.encodeEffect(Schema.fromJsonString(OAuthOperationDecision))({
            reference: review.reference,
            inputDigest: review.inputDigest,
            disclosureRevision: review.disclosureRevision,
            decision: "cancel",
          }),
        })
      );
      expect(response.status).toBe(200);
      const native = yield* wait(fixture.call({ action: "accept", content: { confirm: true } }));
      if (native.status === 200) {
        expect(yield* wait(native.json())).toMatchObject({ result: { isError: true } });
      } else expect([400, 401, 403]).toContain(native.status);
    })
  ));

it("does not approve on GET and refuses expired browser decisions", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* pendingBudgetDeletion();
      const review = yield* readFirstPartyOperation(fixture, fixture.reference);
      expect(review.approved).toBe(false);
      const current = yield* Clock.currentTimeMillis;
      yield* wait(
        fixture.db
          .prepare(
            "UPDATE oauth_operation_intents SET created_at_ms = ?, expires_at_ms = ? WHERE reference = ?"
          )
          .bind(current - 300001, current - 1, fixture.reference)
          .run()
      );
      const response = yield* wait(
        fixture.send("/web/oauth/operation-decision", {
          method: "POST",
          headers: fixture.headers,
          body: yield* Schema.encodeEffect(Schema.fromJsonString(OAuthOperationDecision))({
            reference: review.reference,
            inputDigest: review.inputDigest,
            disclosureRevision: review.disclosureRevision,
            decision: "approve",
          }),
        })
      );
      expect(response.status).toBe(400);
    })
  ));

const alterBrowserAuthority = Effect.fn(function* (
  fixture: NativeFixture,
  attack: (typeof attacks)[number],
  headers: Headers
) {
  if (attack === "bearer-only") {
    headers.delete("cookie");
    headers.delete("Fidy-Session-Binding");
    headers.set("authorization", `Bearer ${fixture.bearer}`);
  }
  if (attack === "wrong-origin") headers.set("origin", "https://evil.example");
  if (attack === "wrong-binding") headers.set("Fidy-Session-Binding", "wrong");
  if (attack === "wrong-user") {
    headers.set("cookie", yield* sessionFor({ db: fixture.db, index: 2 }));
    headers.delete("Fidy-Session-Binding");
    const disclosed = yield* wait(
      fixture.send(`/web/oauth/operation-review?reference=${fixture.reference}`, { headers })
    );
    expect(disclosed.status).toBe(400);
    expect(yield* wait(disclosed.text())).not.toContain(fixture.id);
  }
  if (attack === "stale-session") {
    const now = yield* Clock.currentTimeMillis;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now + 600001);
  }
  if (attack === "revoked-grant") {
    yield* wait(
      fixture.db
        .prepare("UPDATE oauth_connections SET revoked_at_ms = ? WHERE id = ?")
        .bind(yield* Clock.currentTimeMillis, fixture.connectionId)
        .run()
    );
  }
});
