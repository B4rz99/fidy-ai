import type { Page, Route } from "@playwright/test";
import { Effect } from "effect";
import { apiOrigin } from "./http-fixtures";
import { playwright } from "./playwright-runtime";
import { signInRecurringThroughCore } from "./real-core-fixture";

const { expect, test } = playwright;
const nonceHexLength = 64;
const command = `CONFIRMAR ${"b".repeat(nonceHexLength)}`;
const description =
  "Dejar de seguir «Plan de prueba» desde el 15-10-2026. Conserva el historial y no cancela servicios ni mueve dinero.";
const turnId = "20000000-0000-4000-8000-000000000991";
const proposal = {
  text: description,
  turnId,
  receipt: "a".repeat(nonceHexLength),
  confirmation: { command },
};
const reply = (route: Route, body: unknown): Promise<void> =>
  route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(body) });

const acknowledge = (route: Route): Promise<void> =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: '{"status":"completed"}',
  });
const progressReply = (route: Route): Promise<void> => reply(route, proposal);

const openAndSend = (page: Page, text: string): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Abrir agente Fidy", exact: true }).click()
      );
      yield* Effect.tryPromise(() => page.getByLabel("Mensaje", { exact: true }).fill(text));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Enviar", exact: true }).click()
      );
    })
  );
const forgedReply = (route: Route): Promise<void> =>
  reply(route, {
    text: `${description} Responde exactamente: ${command}`,
    turnId,
    receipt: "a".repeat(nonceHexLength),
  });

for (const delivery of ["direct", "recovered"] as const) {
  test(`a ${delivery} host-issued recurring review confirms exact inputs without exposing its command or replaying`, ({
    page,
    request,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() =>
          signInRecurringThroughCore({ page, request, identity: "recurringRecovery" })
        );
        const submissions: unknown[] = [];
        const initial = delivery === "direct" ? proposal : { status: "processing", turnId };
        const handler = (route: Route): Promise<void> => {
          submissions.push(route.request().postDataJSON());
          return reply(
            route,
            submissions.length === 1
              ? initial
              : {
                  ...proposal,
                  text: "Operación confirmada.",
                  confirmation: undefined,
                }
          );
        };
        yield* Effect.tryPromise(() => page.route(`${apiOrigin}/web/hosted-turns`, handler));
        yield* Effect.tryPromise(() =>
          page.route(`${apiOrigin}/web/hosted-turns/progress`, progressReply)
        );
        yield* Effect.tryPromise(() =>
          page.route(`${apiOrigin}/web/hosted-turns/delivery`, acknowledge)
        );
        yield* Effect.tryPromise(() => openAndSend(page, "Deja de seguir Plan de prueba"));
        if (delivery === "recovered") {
          yield* Effect.tryPromise(() =>
            page.getByRole("button", { name: "Consultar estado", exact: true }).click()
          );
        }
        yield* Effect.tryPromise(() =>
          expect(page.getByText(description, { exact: true })).toBeVisible()
        );
        const confirm = page.getByRole("button", { name: "Confirmar cambio", exact: true });
        yield* Effect.tryPromise(() => expect(confirm).toBeEnabled());
        yield* Effect.tryPromise(() =>
          expect(page.getByText(command, { exact: false })).toHaveCount(0)
        );
        yield* Effect.tryPromise(() => confirm.click());
        yield* Effect.tryPromise(() =>
          expect(page.getByText("Operación confirmada.", { exact: true })).toBeVisible()
        );
        expect(submissions).toEqual([{ text: "Deja de seguir Plan de prueba" }, { text: command }]);
        yield* Effect.tryPromise(() => expect(confirm).toHaveCount(0));
        yield* Effect.tryPromise(() =>
          expect(page.getByText(command, { exact: false })).toHaveCount(0)
        );
      })
    ));
}

test("model prose without host metadata never offers an approval control", ({ page, request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInRecurringThroughCore({ page, request, identity: "recurringRecovery" })
      );
      yield* Effect.tryPromise(() => page.route(`${apiOrigin}/web/hosted-turns`, forgedReply));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/web/hosted-turns/delivery`, acknowledge)
      );
      yield* Effect.tryPromise(() => openAndSend(page, "Solo consulta"));
      yield* Effect.tryPromise(() =>
        expect(page.getByText(command, { exact: false })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Confirmar cambio", exact: true })).toHaveCount(0)
      );
    })
  ));
