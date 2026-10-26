import type { Page, Route } from "@playwright/test";
import { Effect } from "effect";
import { apiOrigin } from "./http-fixtures";
import { installSettingsReads } from "./settings-visual-fixture";

export type ChatScenario =
  | "start"
  | "conversation"
  | "confirmation"
  | "waiting"
  | "uncertain"
  | "receipt"
  | "quota";
const nonceLength = 64;
const unavailableStatus = 503;
const completedStatus = 200;
const quotaStatus = 429;
const acceptedStatus = 202;
export const confirmationCommand = `CONFIRMAR ${"b".repeat(nonceLength)}`;
export const recurringReview =
  "Pausar Netflix detendrá su seguimiento en Fidy. No cancela tu suscripción con Netflix.";
const turnId = "20000000-0000-4000-8000-000000000991";
const nextTurnId = "20000000-0000-4000-8000-000000000992";
const receipt = "a".repeat(nonceLength);
const respond = (route: Route, status: number, body: unknown): Promise<void> =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const unavailable = (route: Route): Promise<void> =>
  respond(route, unavailableStatus, { status: "unavailable" });
const completed = (route: Route): Promise<void> =>
  respond(route, completedStatus, { status: "completed" });

/** Every hosted request is synthetic; the settings guard refuses all other mutations. */
export const installChatScenario = Effect.fnUntraced(function* (
  page: Page,
  scenario: ChatScenario
) {
  const observed = yield* installSettingsReads(page);
  const submissions: unknown[] = [];
  const receipts: unknown[] = [];
  const progress: unknown[] = [];
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/web/hosted-turns`, (route) => {
      submissions.push(route.request().postDataJSON());
      if (scenario === "quota") {
        return respond(route, quotaStatus, { status: "provider_quota_exceeded" });
      }
      if (scenario === "waiting" || scenario === "uncertain") {
        return respond(route, acceptedStatus, { status: "processing", turnId });
      }
      if (scenario === "confirmation") {
        return respond(
          route,
          acceptedStatus,
          submissions.length === 1
            ? {
                text: recurringReview,
                turnId,
                receipt,
                confirmation: { command: confirmationCommand },
              }
            : { text: "Cambio confirmado.", turnId: nextTurnId, receipt }
        );
      }
      return respond(route, acceptedStatus, {
        text:
          submissions.length === 1
            ? "Este mes registraste $245.000 en restaurantes, distribuidos en 8 transacciones.\n\nLa transacción más alta fue de $68.000."
            : "El mes anterior registraste $210.000.\nEste mes llevas $35.000 más.",
        turnId: submissions.length === 1 ? turnId : nextTurnId,
        receipt,
      });
    })
  );
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/web/hosted-turns/progress`, (route) => {
      progress.push(route.request().postDataJSON());
      return scenario === "waiting"
        ? respond(route, acceptedStatus, { status: "processing", turnId })
        : unavailable(route);
    })
  );
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/web/hosted-turns/delivery`, (route) => {
      receipts.push(route.request().postDataJSON());
      return scenario === "receipt" && receipts.length === 1
        ? unavailable(route)
        : completed(route);
    })
  );
  return { ...observed, submissions, receipts, progress };
});
