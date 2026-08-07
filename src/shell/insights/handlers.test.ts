import { expect, layer } from "@effect/vitest";
import {
  BigDecimal,
  Context,
  DateTime,
  Effect,
  Equal,
  Layer,
  Option,
  Result,
  Schema,
} from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { AgentTokenId } from "~/core/tokens/reference";
import { IanaTimeZone } from "~/core/_shared/context";
import { Currency, Money } from "~/core/_shared/money";
import { AgentBearerToken } from "~/core/tokens/model";
import { defaultUserId, seedConsentedAgentIdentity } from "~/shell/db/development-seed";
import { ValidationFailed } from "~/shell/_shared/errors";
import { type SuggestedOperation } from "~/shell/_shared/response";
import {
  type ApiClient,
  ApiHarness,
  ApiHarnessClient,
  headersFor,
  makeApiClientLive,
} from "~/shell/testing/api-harness";
import { defaultAgentBearer } from "~/shell/testing/identity-fixtures";
import { truncateInsights, weeklySummaryInput } from "./fixtures";
import { generateInsightEvent } from "./repo";

const cop = Currency.make("COP");
const toolNames = (next: ReadonlyArray<SuggestedOperation>): ReadonlyArray<string> =>
  next.map(({ tool }) => tool);
const toolArgs = (next: ReadonlyArray<SuggestedOperation>): ReadonlyArray<Option.Option<unknown>> =>
  next.map((suggestion) => ("args" in suggestion ? suggestion.args : Option.none()));
const isValidationFailed = Schema.is(ValidationFailed);

const generateWeeklySummary = generateInsightEvent(defaultUserId, weeklySummaryInput());
const concurrentTokenId = AgentTokenId.make("f1d1a000-0000-4000-8000-0000000000d2");
const concurrentBearer = AgentBearerToken.make(
  "fin_race0001_abcdefghijklmnopqrstuvwxyz0123456789ABCD"
);
class ConcurrentApiClient extends Context.Service<ConcurrentApiClient, ApiClient>()(
  "fidy-ai/shell/insights/handlers.test/ConcurrentApiClient"
) {}
const InsightsHarness = makeApiClientLive({
  tag: ConcurrentApiClient,
  bearer: concurrentBearer,
}).pipe(Layer.provideMerge(ApiHarness));

layer(InsightsHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "insight operations",
  (it) => {
    it.effect("lists a generated pending InsightEvent for its User", () =>
      Effect.gen(function* () {
        yield* truncateInsights;
        const client = yield* ApiHarnessClient;
        const generated = yield* generateWeeklySummary;

        const listed = yield* client.insights.listPendingInsights();

        expect(listed.data).toEqual([generated]);
        expect(toolNames(listed.next)).toEqual([
          "insights.markInsightDelivered",
          "insights.markInsightRead",
          "insights.dismissInsight",
        ]);
        expect(toolArgs(listed.next)).toEqual([
          Option.some({ params: { id: generated.id } }),
          Option.some({ params: { id: generated.id } }),
          Option.some({ params: { id: generated.id } }),
        ]);
      })
    );

    it.effect("retains generation context after the User changes current preferences", () =>
      Effect.gen(function* () {
        yield* truncateInsights;
        const client = yield* ApiHarnessClient;
        const generated = yield* generateWeeklySummary;

        const updatedUser = yield* client.identity.updateUserPreferences({
          payload: {
            locale: "es-CO",
            timeZone: IanaTimeZone.make("America/New_York"),
          },
        });
        const listed = yield* client.insights.listPendingInsights();

        expect(updatedUser.data.timeZone).toBe("America/New_York");
        expect(listed.data[0]).toMatchObject({
          id: generated.id,
          serviceMarket: "CO",
          locale: "es-CO",
          timeZone: "America/Bogota",
          scheduledAt: DateTime.makeUnsafe("2026-08-09T23:00:00Z"),
          scheduleId: generated.scheduleId,
          scheduleVersion: 2,
        });
      })
    );

    it.effect("round-trips separate Currency groups without manufacturing a mixed total", () =>
      Effect.gen(function* () {
        yield* truncateInsights;
        const client = yield* ApiHarnessClient;
        const usd = Currency.make("USD");
        yield* generateInsightEvent(
          defaultUserId,
          weeklySummaryInput({
            moneyGroups: [
              {
                currency: cop,
                inflow: Money.make({ amount: BigDecimal.fromStringUnsafe("1000"), currency: cop }),
                outflow: Money.make({ amount: BigDecimal.fromStringUnsafe("800"), currency: cop }),
              },
              {
                currency: usd,
                inflow: Money.make({ amount: BigDecimal.fromStringUnsafe("10"), currency: usd }),
                outflow: Money.make({ amount: BigDecimal.fromStringUnsafe("24.5"), currency: usd }),
              },
            ],
          })
        );

        const [listed] = (yield* client.insights.listPendingInsights()).data;

        expect(listed?.moneyGroups.map(({ currency }) => currency)).toEqual(["COP", "USD"]);
        expect(
          Equal.equals(listed?.moneyGroups[1]?.outflow.amount, BigDecimal.fromStringUnsafe("24.5"))
        ).toBe(true);
        expect(Object.keys(listed ?? {})).not.toContain("total");
      })
    );

    it.effect("records delivery evidence and removes the delivered InsightEvent from pending", () =>
      Effect.gen(function* () {
        yield* truncateInsights;
        const client = yield* ApiHarnessClient;
        const generated = yield* generateWeeklySummary;
        const sentAt = DateTime.makeUnsafe("2026-08-09T23:00:08Z");

        const delivered = yield* client.insights.markInsightDelivered({
          params: { id: generated.id },
          payload: {
            sentAt,
            channel: "whatsapp",
            provider: "kapso",
            providerMessageId: "wamid.delivery-101",
          },
        });

        expect(delivered.data.insight.lifecycleState).toBe("delivered");
        expect(delivered.data.deliveryAttempt).toMatchObject({
          insightEventId: generated.id,
          sentAt,
          channel: "whatsapp",
          provider: "kapso",
          providerMessageId: "wamid.delivery-101",
        });

        expect(toolNames(delivered.next)).toEqual([
          "insights.markInsightRead",
          "insights.dismissInsight",
        ]);

        const pending = yield* client.insights.listPendingInsights();
        expect(pending.data).toEqual([]);
      })
    );

    it.effect("serializes duplicate delivery and conflicting lifecycle calls", () =>
      Effect.gen(function* () {
        yield* truncateInsights;
        yield* seedConsentedAgentIdentity({
          userId: defaultUserId,
          bearer: concurrentBearer,
          tokenId: concurrentTokenId,
          scopes: ["write"],
        });
        const client = yield* ApiHarnessClient;
        const concurrentClient = yield* ConcurrentApiClient;
        const deliveredEvent = yield* generateWeeklySummary;
        const sentAt = DateTime.makeUnsafe("2026-08-09T23:00:08Z");

        const deliveries = yield* Effect.all(
          [
            client.insights
              .markInsightDelivered({
                params: { id: deliveredEvent.id },
                payload: {
                  sentAt,
                  channel: "whatsapp",
                  provider: "kapso",
                  providerMessageId: "wamid.concurrent-1",
                },
              })
              .pipe(Effect.result),
            concurrentClient.insights
              .markInsightDelivered({
                params: { id: deliveredEvent.id },
                payload: {
                  sentAt,
                  channel: "whatsapp",
                  provider: "kapso",
                  providerMessageId: "wamid.concurrent-2",
                },
              })
              .pipe(Effect.result),
          ],
          { concurrency: "unbounded" }
        );
        const accepted = deliveries.filter(Result.isSuccess);
        const rejected = deliveries.filter(Result.isFailure);

        expect(accepted).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        const rejection = rejected[0]?.failure;
        expect(isValidationFailed(rejection) ? rejection.error.code : undefined).toBe(
          "validation_failed"
        );
        expect((yield* client.insights.listPendingInsights()).data).toEqual([]);

        const conflictingEvent = yield* generateWeeklySummary;
        const [, dismissed] = yield* Effect.all(
          [
            client.insights
              .markInsightRead({ params: { id: conflictingEvent.id } })
              .pipe(Effect.result),
            concurrentClient.insights
              .dismissInsight({ params: { id: conflictingEvent.id } })
              .pipe(Effect.result),
          ],
          { concurrency: "unbounded" }
        );

        expect(Result.isSuccess(dismissed)).toBe(true);
        const afterDismissal = yield* Effect.flip(
          client.insights.markInsightRead({ params: { id: conflictingEvent.id } })
        );
        expect(isValidationFailed(afterDismissal) ? afterDismissal.next : undefined).toEqual([]);
      })
    );

    it.effect("rejects oversized delivery evidence without moving the InsightEvent", () =>
      Effect.gen(function* () {
        yield* truncateInsights;
        const client = yield* ApiHarnessClient;
        const generated = yield* generateWeeklySummary;
        const response = yield* HttpClient.post(`/insights/${generated.id}/delivered`, {
          headers: headersFor(defaultAgentBearer),
          body: HttpBody.jsonUnsafe({
            sentAt: "2026-08-09T23:00:08Z",
            channel: "whatsapp",
            provider: "kapso",
            providerMessageId: "m".repeat(257),
          }),
        });

        expect(response.status).toBe(400);
        expect((yield* client.insights.listPendingInsights()).data).toEqual([generated]);
      })
    );

    it.effect("reads a pulled pending InsightEvent without inventing delivery evidence", () =>
      Effect.gen(function* () {
        yield* truncateInsights;
        const client = yield* ApiHarnessClient;
        const generated = yield* generateWeeklySummary;

        const read = yield* client.insights.markInsightRead({ params: { id: generated.id } });

        expect(read.data.lifecycleState).toBe("read");
        expect(toolNames(read.next)).toEqual(["insights.dismissInsight"]);
        expect((yield* client.insights.listPendingInsights()).data).toEqual([]);
      })
    );

    it.effect("dismisses a pending InsightEvent and leaves no valid next lifecycle operation", () =>
      Effect.gen(function* () {
        yield* truncateInsights;
        const client = yield* ApiHarnessClient;
        const generated = yield* generateWeeklySummary;

        const dismissed = yield* client.insights.dismissInsight({
          params: { id: generated.id },
        });

        expect(dismissed.data.lifecycleState).toBe("dismissed");
        expect(dismissed.next).toEqual([]);
      })
    );

    it.effect(
      "rejects a backward transition and suggests only valid calls from the current state",
      () =>
        Effect.gen(function* () {
          yield* truncateInsights;
          const client = yield* ApiHarnessClient;
          const generated = yield* generateWeeklySummary;
          yield* client.insights.markInsightRead({ params: { id: generated.id } });

          const failure = yield* Effect.flip(
            client.insights.markInsightDelivered({
              params: { id: generated.id },
              payload: {
                sentAt: DateTime.makeUnsafe("2026-08-09T23:00:08Z"),
                channel: "whatsapp",
                provider: "kapso",
                providerMessageId: "wamid.too-late",
              },
            })
          );

          expect(isValidationFailed(failure) ? failure.error.code : undefined).toBe(
            "validation_failed"
          );
          expect(toolNames(isValidationFailed(failure) ? failure.next : [])).toEqual([
            "insights.dismissInsight",
          ]);
        })
    );

    it.effect("offers no lifecycle call after a dismissed InsightEvent", () =>
      Effect.gen(function* () {
        yield* truncateInsights;
        const client = yield* ApiHarnessClient;
        const generated = yield* generateWeeklySummary;
        yield* client.insights.dismissInsight({ params: { id: generated.id } });

        const failure = yield* Effect.flip(
          client.insights.markInsightRead({ params: { id: generated.id } })
        );

        expect(isValidationFailed(failure) ? failure.next : undefined).toEqual([]);
        expect(isValidationFailed(failure) ? failure.error.message : "").toContain(
          "No further lifecycle operation is valid"
        );
      })
    );
  }
);
