import { it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { expect } from "vitest";
import { operationCatalog } from "../../src/shell/api";
import { alice, nativeTransactionJourney } from "../financial-user-store.test-fixture";
import { native } from "../user-store.test-fixture";
import { browserOrigins, productionTopology } from "../runtime/contract";

const observedListings = [
  ["budgets.getBudgetStatus", "?timeZone=America%2FBogota"],
  ["categories.listCategories", ""],
  ["dashboard.listDashboardCatalog", ""],
  ["ingestion.getReviewPageContext", ""],
  ["ingestion.getReviewWorkspace", ""],
  ["pats.listPATs", ""],
  ["recurringPlans.getRecurringWorkspace", "?month=2026-10&view=compact"],
  ["subscription.getUpgradeUrl", ""],
  ["subscription.getSubscriptionStatus", ""],
  ["subscription.listSubscriptionOffers", ""],
  ["quota.getQuota", ""],
] as const;

type Journey = Effect.Success<typeof nativeTransactionJourney>;

const listingAccountability = Effect.fn(function* (
  store: Journey,
  [id, query]: (typeof observedListings)[number]
) {
  const operation = operationCatalog.byId.get(id);

  if (operation === undefined) throw new Error("Unknown listing " + id);
  const target = operation.route + query;
  const response = yield* native(() => store.browser(0, target));
  expect(response.status, id).toBe(200);
  yield* native(() => response.arrayBuffer());
  const before = yield* native(() => store.exec("SELECT count(*) AS n FROM audit_entries"));

  const refused = yield* native(() =>
    store.send(
      new Request("https://" + productionTopology.ingress.hostname + target, {
        headers: {
          origin: browserOrigins.production,
          authorization: "Bearer invalid",
          cookie: "__Host-fidy_session=" + alice.bearer,
          "Fidy-Session-Binding": alice.session,
        },
      })
    )
  );

  expect(refused.status, id).toBe(401);
  yield* native(() => refused.arrayBuffer());
  expect(yield* native(() => store.exec("SELECT count(*) AS n FROM audit_entries")), id).toEqual(
    before
  );
  yield* Effect.sleep("120 millis");
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "serves each authorized listing through its native owner and refuses mixed credentials before accountability",
    () =>
      Effect.gen(function* () {
        const store = yield* nativeTransactionJourney;
        yield* native(() =>
          store.exec(
            "UPDATE users SET trial_started_at_ms=created_at_ms,trial_ends_at_ms=created_at_ms+604800000 WHERE id=?",
            alice.user
          )
        );

        yield* Effect.forEach(
          observedListings,
          (listing) => listingAccountability(store, listing),
          {
            discard: true,
          }
        );
      })
  );
});
