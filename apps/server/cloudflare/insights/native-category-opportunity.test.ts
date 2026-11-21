import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";
import { expect } from "vitest";
import { alice, bob, category, seed } from "../financial-user-store.test-fixture";
import { native, nativeHostedPlatform } from "../user-store.test-fixture";
import { chatWith } from "../signed-whatsapp.test-fixture";
import { currentDisclosureFor } from "../../src/shell/consent/operations";
import { DisclosureSnapshot } from "../../src/shell/consent/contract";

const setup = Effect.gen(function* () {
  const runtime = yield* (yield* nativeHostedPlatform)(),
    owner = yield* seed(runtime, alice),
    foreign = yield* seed(runtime, bob);

  const ns = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
  const target = ns.getByName(alice.user);

  const controls = yield* native(() =>
    runtime.getDurableObjectNamespace("CONTROL", "hosted-provider")
  );

  yield* native(() => controls.getByName("provider").fetch("https://fixture.invalid/release"));
  yield* native(() => target.fetch("https://fixture.invalid/hold-alarm"));

  const portfolio = "123456789012345",
    bsuid = "CO.13491208655302741918",
    endpoint = "8444555566667";

  yield* owner.exec(
    "UPDATE users SET whatsapp_portfolio_id=?,whatsapp_bsuid=?,whatsapp_verified_at_ms=? WHERE id=?",
    portfolio,
    bsuid,
    owner.now - 2000,
    alice.user
  );
  yield* native(() =>
    owner.directory.exec(
      "INSERT INTO whatsapp_routes(portfolio,bsuid,user_id,attempt_id,established) VALUES(?,?,?,'setup',1)",
      portfolio,
      bsuid,
      alice.user
    )
  );

  const disclosure = yield* Schema.encodeEffect(Schema.fromJsonString(DisclosureSnapshot))(
    currentDisclosureFor()
  );

  yield* owner.exec(
    "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms,disclosure_json) VALUES(?,?,'processing_grant',?,?)",
    alice.user,
    alice.user,
    owner.now - 1000,
    disclosure
  );

  const alarm = Effect.fn(function* (instant: number) {
    const response = yield* native(() =>
      target.fetch("https://fixture.invalid/clocked-alarm?now=" + instant)
    );

    expect(response.status).toBe(204);
  });

  return { runtime, owner, foreign, target, portfolio, bsuid, endpoint, alarm };
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "retains a first Budget offer without a contact, defers to the morning and needs observed delivery before granting anything",
    () =>
      Effect.gen(function* () {
        const { runtime, owner, foreign, portfolio, bsuid, endpoint, alarm } = yield* setup;

        const created = yield* native(() =>
          runtime.dispatchFetch("https://api.fidyapp.com/budgets", {
            method: "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: "__Host-fidy_session=" + alice.bearer,
              "Fidy-Session-Binding": alice.session,
              "content-type": "application/json",
            },
            body: JSON.stringify({ categoryId: category, cap: { amount: "50", currency: "COP" } }),
          })
        );

        expect(created.status).toBe(201);
        expect(yield* owner.exec("SELECT kind,next_ms FROM category_opportunities")).toEqual([
          { kind: "budget-threshold", next_ms: null },
        ]);

        const incoming = yield* chatWith(runtime, {
          text: "Hola",
          caller: bsuid,
          endpoint,
          secret: "callback-fixture-secret",
          message: "wamid.opportunity",
        });

        yield* native(() => incoming.arrayBuffer());
        expect(yield* owner.exec("SELECT portfolio,bsuid,endpoint FROM insight_contacts")).toEqual([
          { portfolio, bsuid, endpoint },
        ]);
        const day = DateTime.formatIsoDate(DateTime.makeUnsafe(owner.now + 86400000));
        const nighttime = DateTime.toEpochMillis(DateTime.makeUnsafe(day + "T01:00:00Z"));
        const morning = DateTime.toEpochMillis(DateTime.makeUnsafe(day + "T14:00:00Z"));
        yield* alarm(nighttime);
        expect(yield* owner.exec("SELECT next_ms FROM category_opportunities")).toEqual([
          { next_ms: morning },
        ]);
        expect(yield* owner.exec("SELECT id FROM reminder_disclosures")).toEqual([]);
        yield* alarm(morning);
        expect(
          yield* owner.exec(
            "SELECT kind,portfolio,bsuid,endpoint,created_ms FROM reminder_disclosures"
          )
        ).toEqual([{ kind: "budget-threshold", portfolio, bsuid, endpoint, created_ms: morning }]);
        expect(yield* owner.exec("SELECT id FROM proactive_grants")).toEqual([]);
        expect(yield* foreign.exec("SELECT user_id FROM category_opportunities")).toEqual([]);
      })
  );
  test.effect(
    "offers observed recurring discovery only on fresh associated foreground contact and does not duplicate a started disclosure",
    () =>
      Effect.gen(function* () {
        const { runtime, owner, foreign, target, bsuid, endpoint, alarm } = yield* setup;

        const today = DateTime.formatIsoDate(DateTime.makeUnsafe(owner.now)),
          todayMorning = DateTime.toEpochMillis(DateTime.makeUnsafe(today + "T15:00:00Z"));

        const at = todayMorning >= owner.now ? todayMorning : todayMorning + 86400000;
        yield* native(() =>
          target.fetch("https://fixture.invalid/set-opportunity-clock?now=" + at)
        );
        yield* owner.exec(
          "INSERT INTO recurring_series(user_id,id,currency,counterparty_key,series_json,evidence_json,reference_json,valid,confirmation_id,confirmed_at_ms,confirmation_context_json,confirmation_json,digest_excluded,confirmation_sequence) VALUES(?,?,'COP','market','{}','{}','{}',1,?,?,'{\"serviceMarket\":\"CO\",\"locale\":\"es-CO\",\"timeZone\":\"America/Bogota\"}',?,0,1)",
          alice.user,
          alice.session,
          bob.session,
          owner.now,
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            id: bob.session,
            seriesId: alice.session,
            money: { amount: "25.15", currency: "COP" },
            counterparty: "Market",
            confirmedAt: DateTime.formatIso(DateTime.makeUnsafe(owner.now)),
            cadence: { kind: "monthly" },
            announcement: { kind: "suppressed", reason: "backfill" },
          })
        );
        expect(yield* owner.exec("SELECT source FROM category_opportunities")).toEqual([]);

        const first = yield* chatWith(runtime, {
          text: "Hola",
          caller: bsuid,
          endpoint,
          secret: "callback-fixture-secret",
          message: "wamid.discovery",
        });

        yield* native(() => first.arrayBuffer());
        expect(yield* owner.exec("SELECT kind,source FROM category_opportunities")).toEqual([
          { kind: "new-recurring-series", source: "wamid.discovery" },
        ]);
        yield* alarm(at);
        expect(yield* owner.exec("SELECT kind FROM reminder_disclosures")).toEqual([
          { kind: "new-recurring-series" },
        ]);

        const repeated = yield* chatWith(runtime, {
          text: "Hola",
          caller: bsuid,
          endpoint,
          secret: "callback-fixture-secret",
          message: "wamid.next-discovery",
        });

        yield* native(() => repeated.arrayBuffer());
        expect(yield* owner.exec("SELECT source FROM category_opportunities")).toEqual([
          { source: "wamid.discovery" },
        ]);
        expect(yield* owner.exec("SELECT id FROM proactive_grants")).toEqual([]);
        expect(yield* foreign.exec("SELECT source FROM category_opportunities")).toEqual([]);
      })
  );
});
