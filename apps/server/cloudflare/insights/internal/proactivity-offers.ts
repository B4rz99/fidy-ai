import { DateTime, Effect, Option, Schema } from "effect";
import { decideInsightDelivery } from "../../../src/core/insights/operations";
import type { UserId } from "../../../src/core/identity/contract";
import { IanaTimeZone } from "../../../src/core/_shared/context";
import { ProactivityOptInKind } from "../../../src/shell/consent/contract";
import { whatsAppAssociationQuery } from "../../../src/shell/identity/operations";
import {
  createProactivityConsentOffer,
  currentProactivityGrantQuery,
  findCurrentProactivityOffer,
  findProactivityConsentGrant,
  prepareConsentAction,
} from "../../consent/operations";
import type { ProactivityConsentContext, ProactivityConsentOffer } from "../../consent/contract";
import { findInsightRecipient, proactivityStartedDeliveryQuery } from "../../whatsapp/operations";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import type { InsightRecipient } from "../../whatsapp/contract";
import { newId } from "../../secret-material/operations";
import { findFirstBudgetOffer, prepareFirstBudgetOffer } from "../../budgets/operations";
import { InsightUnavailable } from "../contract";

const maximumRequests = 8;
const dayMs = 86400000;
export const requestOffer = (
  input: ProactivityConsentContext & Readonly<{ messageId: string }>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.gen(function* () {
    const association = whatsAppAssociationQuery(input);
    yield* Effect.tryPromise(() =>
      prepareConsentAction({
        db: input.db,
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement: {
          sql: `INSERT OR IGNORE INTO proactivity_offer_requests(id,user_id,kind,request_message_id,created_at_ms) SELECT ?,?,?,?,? WHERE EXISTS (${association.sql}) AND (SELECT count(*) FROM proactivity_offer_requests WHERE user_id=? AND created_at_ms>?)<?`,
          params: [
            newId(),
            input.userId,
            input.kind,
            input.messageId,
            input.now.epochMilliseconds,
            ...association.params,
            input.userId,
            input.now.epochMilliseconds - dayMs,
            maximumRequests,
          ],
        },
      }).run()
    );
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
const RequestRow = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  kind: ProactivityOptInKind,
});
const offerZone = IanaTimeZone.make("America/Bogota");
export const offerWindowOpen = (now: DateTime.Utc): boolean =>
  decideInsightDelivery({
    now,
    scheduledAt: now,
    expiresAt: DateTime.makeUnsafe(now.epochMilliseconds + dayMs),
    timeZone: offerZone,
  })._tag === "Ready";

export const recoverableOfferRequests = (now: DateTime.Utc): OwnedStatement => {
  const started = proactivityStartedDeliveryQuery();
  return {
    sql: `SELECT q.id,q.user_id,q.kind,q.created_at_ms,q.last_evaluated_at_ms FROM proactivity_offer_requests AS q WHERE (q.materialized_at_ms IS NULL OR EXISTS (SELECT 1 FROM proactivity_reports AS r WHERE r.user_id=q.user_id AND r.delivery_id=q.delivery_id AND r.expires_at_ms<=? AND NOT EXISTS (SELECT 1 FROM (${started.sql}) AS c WHERE c.user_id=r.user_id AND c.delivery_id=r.delivery_id)))`,
    params: [now.epochMilliseconds],
  };
};

const offerText = (
  offer: ProactivityConsentOffer,
  kind: ProactivityOptInKind,
  hasGrant: boolean
): string => {
  if (!hasGrant) return `${offer.disclosure.text}\n${offer.acceptChoice}\n${offer.declineChoice}`;
  const choices =
    kind === "manual-entry-reminder"
      ? `${offer.acceptChoice}\n${offer.revokeChoice}`
      : offer.revokeChoice;
  return `${offer.disclosure.text}\n${choices}`;
};

const consentContext = (
  input: Readonly<{ db: D1Database; userId: UserId; now: DateTime.Utc }>,
  kind: ProactivityOptInKind,
  recipient: InsightRecipient
): ProactivityConsentContext => ({
  ...input,
  kind,
  caller: { businessPortfolioId: recipient.portfolioId, businessScopedUserId: recipient.bsuid },
});

const materializeOffer = (
  input: Readonly<{ db: D1Database; userId: UserId; now: DateTime.Utc }>,
  request: typeof RequestRow.Type
): Effect.Effect<void, InsightUnavailable> =>
  Effect.gen(function* () {
    const recipient = yield* findInsightRecipient(input);
    if (Option.isNone(recipient)) return;
    const context = consentContext(input, request.kind, recipient.value);
    const prior = yield* findCurrentProactivityOffer(context);
    const offer = Option.isSome(prior) ? prior : yield* createProactivityConsentOffer(context);
    if (Option.isNone(offer)) return;
    const value = offer.value;
    const grant = yield* findProactivityConsentGrant({ ...input, kind: request.kind });
    const text = offerText(value, request.kind, Option.isSome(grant));
    yield* Effect.tryPromise(() =>
      input.db.batch([
        prepareConsentAction({
          db: input.db,
          subject: { _tag: "User", userId: input.userId },
          requirement: "active",
          statement: {
            sql: "INSERT OR IGNORE INTO proactivity_reports(delivery_id,user_id,role,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM proactivity_offer_requests WHERE user_id=? AND id=? AND materialized_at_ms IS NULL)",
            params: [
              value.id,
              input.userId,
              request.kind === "budget-threshold" ? "budget-offer" : "reminder-offer",
              value.id,
              text,
              input.now.epochMilliseconds,
              value.expiresAt.epochMilliseconds,
              offerZone,
              input.now.epochMilliseconds,
              input.userId,
              request.id,
            ],
          },
        }),
        input.db
          .prepare(
            "INSERT OR IGNORE INTO proactivity_outbox(user_id,delivery_id,created_at_ms) SELECT user_id,delivery_id,created_at_ms FROM proactivity_reports WHERE user_id=? AND delivery_id=?"
          )
          .bind(input.userId, value.id),
        input.db
          .prepare(
            "UPDATE proactivity_offer_requests SET materialized_at_ms=?,delivery_id=? WHERE user_id=? AND id=? AND EXISTS (SELECT 1 FROM proactivity_reports WHERE user_id=? AND delivery_id=?)"
          )
          .bind(
            input.now.epochMilliseconds,
            value.id,
            input.userId,
            request.id,
            input.userId,
            value.id
          ),
      ])
    );
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
const requestFirstBudget = (
  input: Readonly<{ db: D1Database; userId: UserId; now: DateTime.Utc }>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.gen(function* () {
    const first = yield* findFirstBudgetOffer(input);
    if (Option.isNone(first)) return;
    const grant = yield* findProactivityConsentGrant({ ...input, kind: "budget-threshold" });
    if (Option.isSome(grant)) {
      yield* Effect.tryPromise(() =>
        input.db.batch([
          prepareFirstBudgetOffer({
            ...input,
            budgetId: first.value,
            now: input.now.epochMilliseconds,
            proof: currentProactivityGrantQuery({ ...input, kind: "budget-threshold" }),
          }),
        ])
      );
      return;
    }
    const recipient = yield* findInsightRecipient(input);
    if (Option.isNone(recipient)) return;
    const messageId = `first-budget:${first.value}`;
    yield* requestOffer({
      ...input,
      kind: "budget-threshold",
      messageId,
      caller: {
        businessPortfolioId: recipient.value.portfolioId,
        businessScopedUserId: recipient.value.bsuid,
      },
    });
    yield* Effect.tryPromise(() =>
      input.db.batch([
        prepareFirstBudgetOffer({
          ...input,
          budgetId: first.value,
          now: input.now.epochMilliseconds,
          proof: {
            sql: "SELECT 1 FROM proactivity_offer_requests WHERE user_id=? AND kind='budget-threshold' AND request_message_id=?",
            params: [input.userId, messageId],
          },
        }),
      ])
    );
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
export const generateOffers = (
  input: Readonly<{ db: D1Database; userId: UserId; now: DateTime.Utc }>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.gen(function* () {
    yield* requestFirstBudget(input);
    if (!offerWindowOpen(input.now)) return;
    const pending = recoverableOfferRequests(input.now);
    yield* Effect.tryPromise(() =>
      prepareConsentAction({
        db: input.db,
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement: {
          sql: `UPDATE proactivity_offer_requests SET materialized_at_ms=NULL,delivery_id=NULL WHERE user_id=? AND id IN (SELECT id FROM (${pending.sql}) WHERE user_id=? ORDER BY created_at_ms,id LIMIT ?)`,
          params: [input.userId, ...pending.params, input.userId, maximumRequests],
        },
      }).run()
    );
    const raw = yield* Effect.tryPromise(() =>
      prepareConsentAction({
        db: input.db,
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement: {
          sql: "SELECT id,kind FROM (SELECT id,kind FROM proactivity_offer_requests WHERE user_id=? AND materialized_at_ms IS NULL ORDER BY created_at_ms,id LIMIT ?) WHERE 1=1",
          params: [input.userId, maximumRequests],
        },
      }).all()
    );
    const requests = yield* Schema.decodeUnknownEffect(
      Schema.Array(RequestRow).check(Schema.isMaxLength(maximumRequests))
    )(raw.results);
    yield* Effect.forEach(requests, (request) => materializeOffer(input, request), {
      discard: true,
    });
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
