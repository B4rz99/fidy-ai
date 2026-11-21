import { PaymentEnrollment } from "../../src/core/subscription/contract";
import type { Miniflare, Response as MiniflareResponse } from "miniflare";
import { SubscriptionEnrollmentGroup } from "../../src/shell/subscription/contract";
import { type LocalBillingCollection, collectUserBillingUrl } from "./contract";
import { ownerCheckUrl } from "../maintenance/contract";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Data, DateTime, Effect, Option, Schedule, Schema } from "effect";
import { expect } from "vitest";
import { alice, bob, seed } from "../financial-user-store.test-fixture";
import { native, nativeBillingPlatform } from "../user-store.test-fixture";
import { browserOrigins, productionTopology } from "../runtime/contract";

const BillingWire = Data.taggedEnum<typeof LocalBillingCollection.Encoded>();

const canonicalListing = Effect.fn(function* (runtime: Miniflare, path: string) {
  const response = yield* native(() =>
    runtime.dispatchFetch("https://" + productionTopology.ingress.hostname + path, {
      headers: {
        origin: browserOrigins.production,
        "Fidy-Session-Binding": alice.session,
        cookie: "__Host-fidy_session=" + alice.bearer,
      },
    })
  );

  expect(response.status).toBe(200);

  return yield* native(() => response.json());
});

type PublishedPriceTerms = Readonly<{
  id: string;
  money: Readonly<{ amount: string; currency: string }>;
}>;

const assertRenewalTerms = Effect.fn(function* (
  runtime: Miniflare,
  owner: Effect.Success<ReturnType<typeof seed>>,
  later: PublishedPriceTerms
) {
  const stores = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
  const pricing = yield* native(() => runtime.getDurableObjectNamespace("PRICING", "core"));
  const boundary = owner.now - 86401000;
  yield* owner.exec(
    "UPDATE billing_attempts SET status='succeeded',paid_starts_at_ms=?,paid_ends_at_ms=?,finalized_at_ms=?,followup_due_at_ms=?",
    boundary - 2678400000,
    boundary,
    boundary - 2678400000,
    boundary
  );
  yield* owner.exec(
    "UPDATE subscriptions SET current_paid_attempt_id=(SELECT id FROM billing_attempts)"
  );

  yield* native(() => stores.getByName(alice.user).fetch(ownerCheckUrl, { method: "POST" }));
  yield* owner
    .exec("SELECT price_terms FROM billing_attempts WHERE previous_paid_attempt_id IS NOT NULL")
    .pipe(
      Effect.flatMap((rows) =>
        rows.length === 1 ? Effect.void : Effect.fail("renewal missing" as const)
      ),
      Effect.retry({ times: 50, schedule: Schedule.spaced("50 millis") })
    );
  expect(
    yield* owner.exec(
      "SELECT amount,period_starts_at_ms FROM billing_attempts WHERE previous_paid_attempt_id IS NOT NULL"
    )
  ).toEqual([{ amount: "33900", period_starts_at_ms: boundary }]);

  const newest = {
    ...later,
    id: "22480000-0000-4000-8000-000000000010",
    money: { amount: "35900", currency: "COP" },
  };

  expect(
    (yield* native(() =>
      pricing.getByName("pricing").fetch("https://pricing.internal/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          price: newest,
          publicationId: "22480000-0000-4000-8000-000000000011",
          authority: {
            operatorId: "operator-1",
            permission: "pricing.publish",
            expiresAtMs: owner.now + 60000,
          },
        }),
      })
    )).status
  ).toBe(200);
  yield* owner.exec(
    "UPDATE billing_attempts SET status='failed',collection_state='sent',finalized_at_ms=? WHERE renewal_attempt_number=1",
    owner.now
  );
  yield* owner.exec(
    "UPDATE billing_attempts SET followup_due_at_ms=? WHERE previous_paid_attempt_id IS NULL",
    owner.now
  );
  yield* native(() => stores.getByName(alice.user).fetch(ownerCheckUrl, { method: "POST" }));
  yield* owner.exec("SELECT amount FROM billing_attempts WHERE renewal_attempt_number=2").pipe(
    Effect.flatMap((rows) =>
      rows.length === 1 ? Effect.void : Effect.fail("retry missing" as const)
    ),
    Effect.retry({ times: 50, schedule: Schedule.spaced("50 millis") })
  );
  expect(
    yield* owner.exec(
      "SELECT amount,period_starts_at_ms FROM billing_attempts WHERE renewal_attempt_number=2"
    )
  ).toEqual([{ amount: "33900", period_starts_at_ms: boundary }]);
});

const sourceVerifying = Schema.is(Schema.Struct({ status: Schema.Literal("source-verifying") }));

const awaitSubmission = (
  submit: Effect.Effect<MiniflareResponse>
): Effect.Effect<unknown, "source-verifying"> =>
  submit.pipe(
    Effect.flatMap((reply) => native(() => reply.json())),
    Effect.filterOrFail(
      (report) => !sourceVerifying(report),
      () => "source-verifying" as const
    ),
    Effect.retry({ times: 80, schedule: Schedule.spaced("50 millis") })
  );

const recoverEnrollment = Effect.fn(function* (
  restarted: Miniflare,
  { submission, report, operationId }: { submission: unknown; report: unknown; operationId: string }
) {
  const returned = yield* native(() =>
    restarted.dispatchFetch(
      "https://" +
        productionTopology.ingress.hostname +
        "/web/subscription/payment-enrollments/submit",
      {
        method: "POST",
        headers: {
          origin: browserOrigins.production,
          "content-type": "application/json",
          "Fidy-Session-Binding": alice.session,
          cookie: "__Host-fidy_session=" + alice.bearer,
        },
        body: JSON.stringify(submission),
      }
    )
  );

  expect(yield* native(() => returned.json())).toEqual(report);

  const reopened = yield* native(() =>
    restarted.unsafeGetDurableObjectStorage("core", "UserStore", { name: alice.user })
  );

  const exec = (
    ...args: Parameters<typeof reopened.exec>
  ): ReturnType<Effect.Success<ReturnType<typeof seed>>["exec"]> =>
    native(() => reopened.exec(...args));

  const db = yield* native(() =>
    restarted.unsafeGetDurableObjectStorage("wompi-fixture", "ProviderState", { name: "provider" })
  );

  const users = yield* native(() => restarted.getDurableObjectNamespace("USER_STORE", "core"));

  const work = BillingWire.CollectUserBillingAttempt({
    userId: alice.user,
    attemptId: operationId,
  });

  expect(
    (yield* native(() =>
      users
        .getByName(alice.user)
        .fetch(collectUserBillingUrl, { method: "POST", body: JSON.stringify(work) })
    )).status
  ).toBe(204);
  expect(yield* native(() => db.exec("SELECT count(*) AS n FROM charge_posts"))).toEqual([
    { n: 1 },
  ]);

  return exec;
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "enrolls and renews against registered terms after lost replies, atomic rollback and an uncertain charge",
    () =>
      Effect.gen(function* () {
        const create = yield* nativeBillingPlatform;
        const runtime = yield* create();
        const owner = yield* seed(runtime, alice);
        yield* owner.exec(
          "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES ('grant',?,'processing_grant',?)",
          alice.user,
          owner.now
        );

        const response = yield* native(() =>
          runtime.dispatchFetch(
            "https://" +
              productionTopology.ingress.hostname +
              "/web/subscription/payment-enrollments/availability",
            {
              headers: {
                origin: browserOrigins.production,
                "Fidy-Session-Binding": alice.session,
                cookie: "__Host-fidy_session=" + alice.bearer,
              },
            }
          )
        );

        expect(response.status).toBe(200);
        expect(yield* native(() => response.json())).toEqual({ enabledMethods: ["card", "nequi"] });

        const prepared = yield* native(() =>
          runtime.dispatchFetch(
            "https://" +
              productionTopology.ingress.hostname +
              "/web/subscription/payment-enrollments/prepare",
            {
              method: "POST",
              headers: {
                origin: browserOrigins.production,
                "content-type": "application/json",
                "Fidy-Session-Binding": alice.session,
                cookie: "__Host-fidy_session=" + alice.bearer,
              },
              body: JSON.stringify({
                method: "card",
                priceId: "22700000-0000-4000-8000-000000000002",
              }),
            }
          )
        );

        expect(prepared.status).toBe(200);

        const form = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            enrollmentId: Schema.String,
            price: Schema.Record(Schema.String, Schema.Unknown),
            status: Schema.String,
            paymentSourceMode: Schema.String,
          })
        )(yield* native(() => prepared.json()));

        expect(form).toMatchObject({
          status: "prepared",
          price: { money: { amount: "28900", currency: "COP" } },
          paymentSourceMode: "create",
        });
        const pricing = yield* native(() => runtime.getDurableObjectNamespace("PRICING", "core"));
        yield* owner.exec(
          "UPDATE users SET trial_started_at_ms=?,trial_ends_at_ms=? WHERE id=?",
          owner.now,
          owner.now + 604800000,
          alice.user
        );
        expect(yield* canonicalListing(runtime, "/subscription/offers")).toEqual({
          data: [
            { suffix: "1", period: "weekly", amount: "9900" },
            { suffix: "2", period: "monthly", amount: "28900" },
            { suffix: "3", period: "yearly", amount: "289900" },
          ].map(({ suffix, period, amount }) => ({
            id: "22700000-0000-4000-8000-00000000000" + suffix,
            billingPeriod: period,
            serviceMarket: "CO",
            taxTreatment: "not-taxable",
            money: { amount, currency: "COP" },
            renewalTerms: {
              automaticRenewal: true,
              renewalReminder: "none",
              cancellation: "future-renewals-only",
              paidAccessEnds: "paid-period-end",
            },
            paymentMethods: ["card", "nequi", "daviplata"],
          })),
          next: [],
        });
        expect(yield* canonicalListing(runtime, "/subscription/status")).toEqual({
          data: {
            accessTier: "pro",
            hasProGrant: false,
            trialPeriod: {
              startedAt: DateTime.formatIso(DateTime.makeUnsafe(owner.now)),
              endsAt: DateTime.formatIso(DateTime.makeUnsafe(owner.now + 604800000)),
            },
            paidSubscription: null,
            cancellation: null,
            recentAttempts: [],
          },
          next: [],
        });

        const replacement = {
          ...form.price,
          id: "22480000-0000-4000-8000-000000000002",
          money: { amount: "31900", currency: "COP" },
        };

        const publish = yield* native(() =>
          pricing.getByName("pricing").fetch("https://pricing.internal/publish", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              price: replacement,
              publicationId: "22480000-0000-4000-8000-000000000004",
              authority: {
                operatorId: "operator-1",
                permission: "pricing.publish",
                expiresAtMs: owner.now + 60000,
              },
            }),
          })
        );

        expect(publish.status).toBe(200);

        const submit = {
          method: "card",
          paymentSourceMode: "create",
          billingEmail: "payer@example.com",
          cardToken: "tok_test_valid_card",
          enrollmentId: form.enrollmentId,
          paymentRequestId: "22480000-0000-4000-8000-000000000003",
          decisions: {
            acceptedEndUserPolicy: true,
            acceptedPersonalDataAuthorization: true,
            authorizedRecurringCharges: true,
          },
        };

        const send = (path: string, body: unknown): Effect.Effect<MiniflareResponse> =>
          native(() =>
            runtime.dispatchFetch(
              "https://" +
                productionTopology.ingress.hostname +
                "/web/subscription/payment-enrollments/" +
                path,
              {
                method: "POST",
                headers: {
                  origin: browserOrigins.production,
                  "Fidy-Session-Binding": alice.session,
                  cookie: "__Host-fidy_session=" + alice.bearer,
                  "content-type": "application/json",
                },
                body: JSON.stringify(body),
              }
            )
          );

        const refused = yield* send("submit", submit);
        expect(yield* native(() => refused.json())).toEqual({
          status: "refused",
          reason: "terms-changed",
          enrollmentId: form.enrollmentId,
        });
        expect(yield* owner.exec("SELECT COUNT(*) AS n FROM billing_attempts")).toEqual([{ n: 0 }]);
        const fresh = yield* send("prepare", { priceId: replacement.id, method: "card" });

        const next = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ enrollmentId: Schema.String })
        )(yield* native(() => fresh.json()));

        const provider = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("wompi-fixture", "ProviderState", {
            name: "provider",
          })
        );

        yield* native(() =>
          provider.exec(
            "CREATE TABLE charge_posts(reference TEXT,amount INTEGER,currency TEXT,source INTEGER); CREATE TABLE charge_control(released INTEGER,reference TEXT,amount INTEGER,source INTEGER); INSERT INTO charge_control(released) VALUES(1)"
          )
        );

        const submission = {
          ...submit,
          enrollmentId: next.enrollmentId,
          paymentRequestId: "22480000-0000-4000-8000-000000000005",
        };

        yield* owner.exec(
          "CREATE TRIGGER discard_registration BEFORE UPDATE OF terms ON billing_admissions WHEN OLD.terms IS NULL BEGIN SELECT RAISE(ABORT,'lost_price_reply'); END"
        );
        expect((yield* send("submit", submission)).status).toBe(503);

        const [saved] = yield* owner.exec(
          "SELECT request FROM billing_admissions WHERE subject_id=?",
          next.enrollmentId
        );

        const registeredRequest = yield* Schema.decodeUnknownEffect(Schema.String)(saved?.request);

        const register = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({ deadlineMs: Schema.Int, operationId: Schema.String })
          )
        )(registeredRequest);

        const later = {
          ...replacement,
          id: "22480000-0000-4000-8000-000000000009",
          money: { amount: "33900", currency: "COP" },
        };

        const published = yield* native(() =>
          pricing.getByName("pricing").fetch("https://pricing.internal/publish", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              price: later,
              publicationId: "22480000-0000-4000-8000-000000000008",
              authority: {
                operatorId: "operator-1",
                permission: "pricing.publish",
                expiresAtMs: owner.now + 60000,
              },
            }),
          })
        );

        expect(published.status).toBe(200);

        const original = yield* native(() =>
          pricing.getByName("pricing").fetch("https://pricing.internal/register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: registeredRequest,
          })
        );

        expect(yield* native(() => original.json())).toMatchObject({
          price: { id: replacement.id },
          deadlineMs: register.deadlineMs,
        });
        yield* owner.exec("DROP TRIGGER discard_registration");
        const stores = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
        const other = yield* seed(runtime, bob);
        yield* other.exec(
          "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES('grant',?,'processing_grant',?)",
          bob.user,
          other.now
        );
        expect(
          (yield* native(() =>
            stores.getByName(bob.user).fetch("https://user.invalid/billing/registration-cancel", {
              method: "POST",
              body: registeredRequest,
            })
          )).status
        ).toBe(404);
        expect(
          (yield* native(() =>
            stores
              .getByName(alice.user)
              .fetch("https://user.invalid/billing/registration-outcome", {
                method: "POST",
                body: registeredRequest,
              })
          )).status
        ).toBe(409);
        yield* owner.exec(
          "CREATE TRIGGER reject_billing_audit BEFORE INSERT ON billing_transition_audit BEGIN SELECT RAISE(IGNORE); END"
        );
        expect((yield* send("submit", submission)).status).toBe(503);
        expect(yield* owner.exec("SELECT count(*) AS n FROM billing_attempts")).toEqual([{ n: 0 }]);
        expect(yield* owner.exec("SELECT count(*) AS n FROM payment_sources")).toEqual([{ n: 0 }]);
        yield* owner.exec("DROP TRIGGER reject_billing_audit");
        yield* owner.exec(
          "UPDATE payment_enrollments SET next_lookup_ms=? WHERE id=?",
          owner.now,
          next.enrollmentId
        );
        const report = yield* awaitSubmission(send("submit", submission));
        expect(report).toMatchObject({
          status: "payment-pending",
          billingAttempt: { priceId: replacement.id, money: replacement.money },
        });
        const replay = yield* send("submit", submission);
        expect(yield* native(() => replay.json())).toEqual(report);
        expect(
          (yield* send("submit", { ...submission, billingEmail: "another@example.com" })).status
        ).toBe(400);
        expect(yield* other.exec("SELECT count(*) AS n FROM billing_attempts")).toEqual([{ n: 0 }]);

        const terminal = yield* native(() =>
          stores.getByName(alice.user).fetch("https://user.invalid/billing/registration-cancel", {
            method: "POST",
            body: registeredRequest,
          })
        );

        expect(yield* native(() => terminal.json())).toMatchObject({
          outcome: "committed",
          request: { deadlineMs: register.deadlineMs },
        });
        expect(
          (yield* native(() =>
            stores.getByName(alice.user).fetch(ownerCheckUrl, { method: "POST" })
          )).status
        ).toBe(204);
        yield* native(() => provider.exec("SELECT count(*) AS n FROM charge_posts")).pipe(
          Effect.flatMap((rows) =>
            rows[0]?.n === 1 ? Effect.void : Effect.fail("waiting" as const)
          ),
          Effect.retry({ times: 80, schedule: Schedule.spaced("50 millis") })
        );
        expect(yield* owner.exec("SELECT collection_state,status FROM billing_attempts")).toEqual([
          { collection_state: "sent", status: "pending" },
        ]);
        expect(yield* native(() => provider.exec("SELECT * FROM charge_posts"))).toEqual([
          {
            reference: "fidy-" + register.operationId,
            amount: 3190000,
            currency: "COP",
            source: 5101,
          },
        ]);

        yield* native(() => runtime.dispose());
        const restarted = yield* create();

        const exec = yield* recoverEnrollment(restarted, {
          submission,
          report,
          operationId: register.operationId,
        });

        yield* assertRenewalTerms(restarted, { ...owner, exec }, later);
      })
  );
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "keeps enrollment browser-only, requires verified wallet approval, and fences cancelled and expired work",
    Effect.fnUntraced(function* () {
      const create = yield* nativeBillingPlatform;
      const runtime = yield* create();
      const owner = yield* seed(runtime, alice);
      const stores = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));

      const headers = {
        origin: browserOrigins.production,
        "content-type": "application/json",
        "Fidy-Session-Binding": alice.session,
        cookie: "__Host-fidy_session=" + alice.bearer,
      };

      const api = "https://" + productionTopology.ingress.hostname;
      const prefix = "/web/subscription/payment-enrollments/";

      const dispatchWithHeaders = (
        path: string,
        method: string,
        requestHeaders: Headers
      ): Effect.Effect<MiniflareResponse> =>
        native(() =>
          runtime.dispatchFetch(api + path, {
            method,
            headers: Object.fromEntries(requestHeaders),
          })
        );

      const send = (
        path: string,
        method: string,
        body?: unknown
      ): Effect.Effect<MiniflareResponse> =>
        native(() =>
          runtime.dispatchFetch(api + path, {
            method,
            headers,
            ...Option.match(Option.fromUndefinedOr(body), {
              onNone: () => ({}),
              onSome: (body) => ({ body: JSON.stringify(body) }),
            }),
          })
        );

      expect((yield* send(prefix + "availability", "GET")).status).toBe(401);
      yield* owner.exec(
        "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES('grant',?,'processing_grant',?)",
        alice.user,
        owner.now
      );

      yield* Effect.forEach(
        Object.values(SubscriptionEnrollmentGroup.endpoints),
        Effect.fnUntraced(function* (endpoint) {
          const path = endpoint.path.replace(/:[^/]+/u, "10000000-0000-4000-8000-000000000001");

          const preflight = yield* native(() =>
            runtime.dispatchFetch(api + path, {
              method: "OPTIONS",
              headers: {
                origin: browserOrigins.production,
                "Access-Control-Request-Method": endpoint.method,
                "Access-Control-Request-Headers": "content-type",
              },
            })
          );

          expect(preflight.status).toBe(204);
          expect(preflight.headers.get("access-control-allow-origin")).toBe(
            browserOrigins.production
          );
          expect((yield* send(path, endpoint.method === "GET" ? "POST" : "GET")).status).toBe(405);

          yield* Effect.forEach(
            ["cookie", "origin", "binding"],
            Effect.fnUntraced(function* (missing) {
              const modified = new Headers(headers);
              modified.delete(missing === "binding" ? "Fidy-Session-Binding" : missing);
              modified.set("authorization", "Bearer unrelated");

              const denied = yield* dispatchWithHeaders(path, endpoint.method, modified);

              expect(denied.status).toBe(missing === "origin" ? 403 : 401);
            }),
            { discard: true }
          );
        }),
        { discard: true }
      );

      const prepare = (): Effect.Effect<MiniflareResponse> =>
        send(prefix + "prepare", "POST", {
          priceId: "22700000-0000-4000-8000-000000000002",
          method: "nequi",
        });

      const formId = Schema.decodeUnknownEffect(Schema.Struct({ enrollmentId: Schema.String }));
      const opened = yield* prepare();
      const first = yield* formId(yield* native(() => opened.json()));

      const submit = (
        enrollmentId: string,
        token: string,
        request: string
      ): Effect.Effect<MiniflareResponse> =>
        send(prefix + "submit", "POST", {
          enrollmentId,
          paymentRequestId: request,
          method: "nequi",
          paymentSourceMode: "create",
          billingEmail: "payer@example.com",
          nequiToken: token,
          decisions: {
            acceptedEndUserPolicy: true,
            acceptedPersonalDataAuthorization: true,
            authorizedRecurringCharges: true,
          },
        });

      const request = "22480000-0000-4000-8000-000000000061";
      expect((yield* submit(first.enrollmentId, "nequi_test_pending", request)).status).toBe(400);

      const [row] = yield* owner.exec(
        "SELECT request FROM billing_admissions WHERE subject_id=?",
        first.enrollmentId
      );

      const pendingRequest = yield* Schema.decodeUnknownEffect(Schema.String)(row?.request);
      yield* owner.exec(
        "CREATE TRIGGER ignore_fence BEFORE UPDATE OF outcome ON billing_admissions WHEN NEW.outcome='cancelled' BEGIN SELECT RAISE(IGNORE); END"
      );

      const uncertain = yield* native(() =>
        stores.getByName(alice.user).fetch("https://user.invalid/billing/registration-cancel", {
          method: "POST",
          body: pendingRequest,
        })
      );

      expect(uncertain.status).toBe(503);
      yield* owner.exec("DROP TRIGGER ignore_fence");

      const cancel = yield* native(() =>
        stores.getByName(alice.user).fetch("https://user.invalid/billing/registration-cancel", {
          method: "POST",
          body: pendingRequest,
        })
      );

      expect(yield* native(() => cancel.json())).toMatchObject({ outcome: "cancelled" });
      const late = yield* submit(first.enrollmentId, "nequi_test_pending", request);
      expect(yield* native(() => late.json())).toMatchObject({ status: "refused" });
      const second = yield* prepare();
      const expired = yield* formId(yield* native(() => second.json()));
      yield* owner.exec(
        "UPDATE payment_enrollments SET deadline_ms=? WHERE id=?",
        owner.now,
        expired.enrollmentId
      );

      const after = yield* submit(
        expired.enrollmentId,
        "nequi_test_approved",
        "22480000-0000-4000-8000-000000000062"
      );

      expect(yield* native(() => after.json())).toMatchObject({
        status: "refused",
        reason: "expired",
      });
      expect(yield* owner.exec("SELECT count(*) AS n FROM billing_attempts")).toEqual([{ n: 0 }]);
      const status = yield* send(prefix + expired.enrollmentId, "GET");
      expect(
        yield* Schema.decodeUnknownEffect(PaymentEnrollment)(yield* native(() => status.json()))
      ).toMatchObject({
        status: "expired",
        enrollmentId: expired.enrollmentId,
      });
      const third = yield* prepare();
      const active = yield* formId(yield* native(() => third.json()));

      const approve = yield* awaitSubmission(
        submit(active.enrollmentId, "nequi_test_approved", "22480000-0000-4000-8000-000000000063")
      );

      expect(approve).toMatchObject({ status: "payment-pending" });
      yield* owner.exec(
        "UPDATE web_sessions SET created_at_ms=created_at_ms-600001,fresh_until_ms=fresh_until_ms-600001,hard_expires_at_ms=hard_expires_at_ms-600001"
      );
      expect((yield* send(prefix + "availability", "GET")).status).toBe(401);
      yield* owner.exec("UPDATE web_sessions SET revoked_at_ms=?", owner.now);

      const previous = yield* owner.exec(
        "SELECT count(*) AS n FROM audit_entries WHERE operation='subscription.getSubscriptionStatus'"
      );

      expect((yield* send("/subscription/status", "GET")).status).toBe(401);
      expect(
        yield* owner.exec(
          "SELECT count(*) AS n FROM audit_entries WHERE operation='subscription.getSubscriptionStatus'"
        )
      ).toEqual(previous);
    })
  );
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect.each([
    ["sandbox", "disabled", true],
    ["production", "disabled", false],
    ["production", "enabled", true],
  ] as const)(
    "gates DaviPlata on the %s deployment with activation %s",
    ([environment, activation, enabled]) =>
      Effect.gen(function* () {
        const create = yield* nativeBillingPlatform;
        const payments = environment === "sandbox" ? "test" : "prod";
        const endpoint = "https://" + environment + ".wompi.co/v1/daviplata/authorization";

        const runtime = yield* create("1000000000", [], {
          WOMPI_ENVIRONMENT: environment,
          WOMPI_DAVIPLATA_ACTIVATED: activation,
          WOMPI_PUBLIC_KEY: "pub_" + payments + "_testfixture",
          WOMPI_PRIVATE_KEY: "prv_" + payments + "_testfixture",
          WOMPI_INTEGRITY_SECRET: payments + "_integrity_testfixture",
          WOMPI_DAVIPLATA_OTP_SEND_URL: endpoint,
          WOMPI_DAVIPLATA_OTP_CONFIRM_URL: endpoint,
        });

        const owner = yield* seed(runtime, alice);
        yield* owner.exec(
          "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES('grant',?,'processing_grant',?)",
          alice.user,
          owner.now
        );

        const reply = yield* native(() =>
          runtime.dispatchFetch(
            "https://" +
              productionTopology.ingress.hostname +
              "/web/subscription/payment-enrollments/availability",
            {
              headers: {
                origin: browserOrigins.production,
                "Fidy-Session-Binding": alice.session,
                cookie: "__Host-fidy_session=" + alice.bearer,
              },
            }
          )
        );

        expect(reply.headers.get("cache-control")).toBe("no-store");
        expect(yield* native(() => reply.json())).toEqual({
          enabledMethods: enabled ? ["card", "nequi", "daviplata"] : ["card", "nequi"],
        });
      })
  );
});
