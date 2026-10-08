import { Hex } from "effect/encoding";
import { DateTime, Effect, Option, Schema } from "effect";
import type {
  WhatsAppInboundEvent,
  WhatsAppSendFailed,
  WhatsAppSentMessage,
} from "../../../src/shell/channels/whatsapp/contract";
import { decideConsentReply } from "../../../src/shell/consent/operations";
import { prepareAcceptedConsentCaller } from "../../consent/operations";
import { admitResource } from "../../resource-admission/operations";
import {
  ResourceAdmissionCharges,
  ResourceAdmissionDurationMs,
  ResourceAdmissionEpochMs,
  ResourceAdmissionGrantId,
  ResourceAdmissionLimit,
  ResourceAdmissionPolicies,
  ResourceAdmissionPolicyKey,
  ResourceAdmissionScopeKey,
  ResourceAdmissionUnits,
} from "../../resource-admission/contract";
import { digestBytes, newId } from "../../secret-material/operations";
import type { WhatsAppAuthenticatedInbound } from "../../whatsapp/contract";

const HTTP_OK = 200;
const HTTP_CONFLICT = 409;
const HTTP_UNAVAILABLE = 503;
const handoffLifetimeMs = 600000;
const response = (status: number): Response =>
  new Response(null, { status, headers: { "cache-control": "no-store" } });
const Handoff = Schema.Struct({
  id: Schema.String,
  pairing_id: Schema.NullOr(Schema.String),
  review_code: Schema.NullOr(Schema.String),
  review_started_ms: Schema.NullOr(Schema.Int),
  review_message_id: Schema.NullOr(Schema.String),
  decision: Schema.NullOr(Schema.String),
  consumed_at_ms: Schema.NullOr(Schema.Int),
  expires_at_ms: Schema.Int,
});
const Accepted = Schema.Struct({ exchange_id: Schema.String });
type Input = Readonly<{
  db: D1Database;
  browserOrigin: string;
  inbound: WhatsAppAuthenticatedInbound;
  send: (
    input: Readonly<{ event: WhatsAppInboundEvent; text: string }>
  ) => Effect.Effect<WhatsAppSentMessage, WhatsAppSendFailed>;
}>;
const hourMs = 3600000;
const maximumHourlySends = 1000;
const sendPolicyKey = ResourceAdmissionPolicyKey.make("provider.whatsapp.egress.v1");
const dayMs = 86400000;
const maximumDailyCallerSends = 6;
const sourcePolicyKey = ResourceAdmissionPolicyKey.make("provider.whatsapp.source.v1");
const sendPolicies = ResourceAdmissionPolicies.make([
  {
    kind: "rolling_window",
    dimension: "source",
    key: sourcePolicyKey,
    durationMs: ResourceAdmissionDurationMs.make(dayMs),
    limit: ResourceAdmissionLimit.make(maximumDailyCallerSends),
  },
  {
    kind: "rolling_window",
    dimension: "spend",
    key: sendPolicyKey,
    durationMs: ResourceAdmissionDurationMs.make(hourMs),
    limit: ResourceAdmissionLimit.make(maximumHourlySends),
  },
]);
const authorizeSend = (input: Input): Effect.Effect<void, void> =>
  Effect.gen(function* () {
    const caller = input.inbound.event.caller;
    const source = Hex.encode(
      yield* digestBytes(
        new TextEncoder().encode(
          `${caller.businessPortfolioId.length}:${caller.businessPortfolioId}${caller.businessScopedUserId.length}:${caller.businessScopedUserId}`
        )
      )
    );
    yield* admitResource(
      {
        database: input.db,
        nowEpochMs: () => ResourceAdmissionEpochMs.make(input.inbound.receivedAtMs),
        policies: sendPolicies,
      },
      {
        grantId: ResourceAdmissionGrantId.make(newId()),
        charges: ResourceAdmissionCharges.make([
          {
            policyKey: sendPolicyKey,
            scopeKey: ResourceAdmissionScopeKey.make("kapso"),
            units: ResourceAdmissionUnits.make(1),
          },
          {
            policyKey: sourcePolicyKey,
            scopeKey: ResourceAdmissionScopeKey.make(source),
            units: ResourceAdmissionUnits.make(1),
          },
        ]),
        statements: [],
      }
    );
  }).pipe(Effect.mapError(() => undefined));
const currentCaller = (input: Input): ReadonlyArray<string | number> => [
  input.inbound.event.caller.businessPortfolioId,
  input.inbound.event.caller.businessScopedUserId,
  input.inbound.event.businessPhoneNumberId,
  input.inbound.receivedAtMs,
];
const readHandoff = (input: Input): D1PreparedStatement =>
  prepareAcceptedConsentCaller({
    db: input.db,
    statement: {
      sql: `SELECT h.* FROM whatsapp_provider_handoffs h JOIN accepted_consent_callers e ON e.exchange_id=h.exchange_id WHERE e.portfolio_id=? AND e.bsuid=? AND e.phone_number_id=? AND e.expires_at_ms>? ORDER BY h.created_at_ms DESC LIMIT 1`,
      params: currentCaller(input),
    },
  });
const confirm = (
  input: Input,
  handoff: typeof Handoff.Type,
  choice: Readonly<{ code: string; decision: "confirmed" | "denied" }>
): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    const { code, decision } = choice;
    const event = input.inbound.event;
    const reply = Option.getOrElse(event.replyToMessageId, () => "");
    if (
      handoff.review_code !== code ||
      handoff.review_message_id === null ||
      reply !== handoff.review_message_id ||
      handoff.review_started_ms === null ||
      DateTime.toEpochMillis(event.occurredAt) <= handoff.review_started_ms
    ) {
      return response(HTTP_CONFLICT);
    }
    const result = yield* Effect.tryPromise(() =>
      prepareAcceptedConsentCaller({
        db: input.db,
        statement: {
          sql: `UPDATE whatsapp_provider_handoffs SET decision=?,decision_message_id=?,confirmed_at_ms=? WHERE id=? AND review_code=? AND review_message_id=? AND decision IS NULL AND consumed_at_ms IS NULL AND expires_at_ms>? AND exchange_id IN (SELECT exchange_id FROM accepted_consent_callers WHERE portfolio_id=? AND bsuid=? AND phone_number_id=? AND expires_at_ms>?)`,
          params: [
            decision,
            event.messageEvidence.providerMessageId,
            input.inbound.receivedAtMs,
            handoff.id,
            code,
            reply,
            input.inbound.receivedAtMs,
            ...currentCaller(input),
          ],
        },
      }).run()
    );
    return response(result.meta.changes === 1 ? HTTP_OK : HTTP_CONFLICT);
  }).pipe(Effect.mapError(() => undefined));
const sendReview = (input: Input, handoff: typeof Handoff.Type): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          "SELECT provider,contact_email,subject FROM provider_authentication_attempts WHERE handoff_id=? AND state='verified' AND expires_at_ms>?"
        )
        .bind(handoff.id, input.inbound.receivedAtMs)
        .first()
    );
    if (raw === null) return response(HTTP_CONFLICT);
    const account = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        provider: Schema.Literals(["google", "microsoft"]),
        contact_email: Schema.NullOr(Schema.String),
        subject: Schema.String,
      })
    )(raw);
    const claimed = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          "UPDATE whatsapp_provider_handoffs SET review_started_ms=? WHERE id=? AND review_started_ms IS NULL AND decision IS NULL AND consumed_at_ms IS NULL AND expires_at_ms>?"
        )
        .bind(input.inbound.receivedAtMs, handoff.id, input.inbound.receivedAtMs)
        .run()
    );
    if (claimed.meta.changes !== 1) {
      return response(handoff.review_message_id !== null ? HTTP_OK : HTTP_UNAVAILABLE);
    }
    const code = handoff.review_code ?? "";
    yield* authorizeSend(input);
    const sent = yield* input.send({
      event: input.inbound.event,
      text: `Vas a asociar este chat con la cuenta de ${account.provider === "google" ? "Google" : "Microsoft"}: ${account.contact_email ?? "sin correo de contacto"}. Identificador del proveedor: ${account.subject}.\nCompara el identificador de asociación ${code} con el que aparece en Fidy. Si no iniciaste este proceso, no confirmes.\nResponde a ESTE mensaje con “Confirmo asociación ${code}” o “Rechazo asociación ${code}”. Esto permite que este chat acceda a esa cuenta. No reemplaza una asociación existente.`,
    });
    yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          "UPDATE whatsapp_provider_handoffs SET review_message_id=? WHERE id=? AND review_message_id IS NULL AND decision IS NULL"
        )
        .bind(sent.messageEvidence.providerMessageId, handoff.id)
        .run()
    );
    return response(HTTP_OK);
  }).pipe(Effect.mapError(() => undefined));
const startHandoff = (input: Input): Effect.Effect<Option.Option<Response>, void> =>
  Effect.gen(function* () {
    const accepted = yield* Effect.tryPromise(() =>
      prepareAcceptedConsentCaller({
        db: input.db,
        statement: {
          sql: "SELECT exchange_id FROM accepted_consent_callers WHERE portfolio_id=? AND bsuid=? AND phone_number_id=? AND expires_at_ms>? ORDER BY expires_at_ms DESC LIMIT 1",
          params: currentCaller(input),
        },
      }).first()
    );
    if (accepted === null) return Option.none();
    const exchange = yield* Schema.decodeUnknownEffect(Accepted)(accepted);
    if (
      input.browserOrigin !== "https://app.fidyapp.com" &&
      input.browserOrigin !== "https://127.0.0.1:4174" &&
      input.browserOrigin !== "http://127.0.0.1:5173"
    ) {
      return Option.some(response(HTTP_UNAVAILABLE));
    }
    const id = newId();
    const now = input.inbound.receivedAtMs;
    const claimed = yield* Effect.tryPromise(() =>
      prepareAcceptedConsentCaller({
        db: input.db,
        statement: {
          sql: `INSERT INTO whatsapp_provider_handoffs(id,exchange_id,created_at_ms,expires_at_ms,handoff_send_started_ms) SELECT ?,exchange_id,?,MIN(?,expires_at_ms),? FROM accepted_consent_callers WHERE exchange_id=? AND portfolio_id=? AND bsuid=? AND phone_number_id=? AND expires_at_ms>? AND NOT EXISTS(SELECT 1 FROM whatsapp_provider_handoffs h WHERE h.exchange_id=accepted_consent_callers.exchange_id AND h.expires_at_ms>?)`,
          params: [
            id,
            now,
            now + handoffLifetimeMs,
            now,
            exchange.exchange_id,
            ...currentCaller(input),
            now,
          ],
        },
      }).run()
    );
    if (claimed.meta.changes !== 1) return Option.some(response(HTTP_CONFLICT));
    yield* authorizeSend(input);
    yield* input.send({
      event: input.inbound.event,
      text: `Consentimiento registrado. Abre ${input.browserOrigin}/auth/google?handoff=${id} para autenticarte con Google o Microsoft. Después vuelve a este chat y escribe “Estado” para revisar y confirmar la asociación. El enlace por sí solo no autoriza acceso. No envíes códigos de recuperación ni credenciales por WhatsApp. Si el intento vence, escribe “Reiniciar” para obtener un enlace nuevo.`,
    });
    return Option.some(response(HTTP_OK));
  }).pipe(Effect.mapError(() => undefined));
const routeHandoff = (
  input: Input,
  handoff: typeof Handoff.Type,
  text: string
): Effect.Effect<Response, void> => {
  if (
    handoff.expires_at_ms <= input.inbound.receivedAtMs &&
    text.toLocaleLowerCase("es-CO") === "reiniciar"
  ) {
    return startHandoff(input).pipe(
      Effect.map((value) => Option.getOrElse(value, () => response(HTTP_CONFLICT)))
    );
  }
  if (handoff.expires_at_ms <= input.inbound.receivedAtMs || handoff.consumed_at_ms !== null) {
    return Effect.succeed(response(HTTP_CONFLICT));
  }
  return routeLiveHandoff(input, handoff, text);
};
const routeLiveHandoff = (
  input: Input,
  handoff: typeof Handoff.Type,
  text: string
): Effect.Effect<Response, void> => {
  const choice = /^(Confirmo|Rechazo) asociación ([0-9a-f-]{36})$/u.exec(text);
  if (choice !== null) {
    return confirm(input, handoff, {
      code: choice[2] ?? "",
      decision: choice[1] === "Confirmo" ? "confirmed" : "denied",
    });
  }
  if (handoff.pairing_id !== null && text.toLocaleLowerCase("es-CO") === "estado") {
    return sendReview(input, handoff);
  }
  return Effect.succeed(response(HTTP_OK));
};
/** Only authenticated native text may create a public reference or confirm its immutable reviewed association. */
export const receiveHandoffText = (input: Input): Effect.Effect<Option.Option<Response>, never> =>
  Effect.gen(function* () {
    if (input.inbound.event.content._tag !== "Text") return Option.none();
    const text = input.inbound.event.content.text.trim();
    const choice = yield* decideConsentReply({ _tag: "Text", text });
    const raw = yield* Effect.tryPromise(() => readHandoff(input).first());
    if (raw !== null) {
      if (choice._tag !== "Clarify") return Option.none();
      const handoff = yield* Schema.decodeUnknownEffect(Handoff)(raw);
      return Option.some(yield* routeHandoff(input, handoff, text));
    }
    if (/^(Confirmo|Rechazo) asociación /u.test(text)) return Option.some(response(HTTP_CONFLICT));
    return yield* startHandoff(input);
  }).pipe(Effect.orElseSucceed(() => Option.some(response(HTTP_UNAVAILABLE))));
