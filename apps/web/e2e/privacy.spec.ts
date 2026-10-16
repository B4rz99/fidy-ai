import { type Cause, Effect, Schema } from "effect";
import { playwright } from "./playwright-runtime";
import {
  signInPrivacyErasureThroughCore,
  signInPrivacyRenewalThroughCore,
  signInPrivacyThroughCore,
} from "./real-core-fixture";
import type { Locator, Page, Route } from "@playwright/test";
import { apiOrigin } from "./http-fixtures";
import { exerciseTitularCase } from "./titular-case-fixture";

const { AxeBuilder } = await import("@axe-core/playwright");
const { expect, test } = playwright;
const unauthenticatedStatus = 401;
const successStatus = 200;
const unavailableResponse = (route: Route): Promise<void> => route.fulfill({ status: 503 });
const acceptedStatus = 202;
const withdrawalCheckbox = (page: Page): Locator =>
  page.getByRole("checkbox", {
    name: "Entiendo las consecuencias y quiero retirar mi autorización de tratamiento.",
  });

const verifyAccessibility = (page: Page): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise(() => new AxeBuilder({ page }).analyze());
      expect(
        result.violations.filter(({ impact }) => impact === "serious" || impact === "critical")
      ).toEqual([]);
    })
  );

const captureAccessResponse = (route: Route, capture: (payload: unknown) => void): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise(() => route.fetch());
      capture(yield* Effect.tryPromise(() => response.json()));
      yield* Effect.tryPromise(() => route.fulfill({ response }));
    })
  );

const verifyTransactionAccess = (page: Page): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      let payload: unknown;
      const endpoint = `${apiOrigin}/web/privacy/transactions`;
      const capture = (value: unknown): void => {
        payload = value;
      };
      yield* Effect.tryPromise(() =>
        page.route(endpoint, (route) => captureAccessResponse(route, capture))
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Ver mis transacciones", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/app\/transactions$/));
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Solo lectura", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("table", { name: "Tabla de transacciones" })).toContainText("12.000")
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Editar varias", exact: true })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        page
          .getByRole("button", { name: "Ver transacción Contraparte no identificada", exact: true })
          .click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("region", { name: "Detalle de transacción" })).toContainText(
          "Solicitud de acceso de prueba"
        )
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Eliminar transacción", exact: true })).toHaveCount(
          0
        )
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("24000000-0000-4000-8000-000000000383", { exact: true })).toHaveCount(
          0
        )
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Referencia de consulta:", { exact: false })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() => page.unroute(endpoint));
      const { reference: ownerResultRef } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ reference: Schema.String.check(Schema.isUUID()) })
      )(payload);
      yield* Effect.tryPromise(() => exerciseTitularCase(ownerResultRef));
    })
  );

const verifyAuthorizationRecovery = (page: Page): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const withdraw = page.getByRole("button", { name: "Retirar autorización", exact: true });
      const copyEndpoint = `${apiOrigin}/web/consent/authorization`;
      yield* Effect.tryPromise(() =>
        page.route(copyEndpoint, (route) => route.fulfill({ status: 503 }))
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Consultar prueba", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toContainText("No pudimos consultar la prueba")
      );
      yield* Effect.tryPromise(() => expect(withdraw).toBeDisabled());
      yield* Effect.tryPromise(() => expect(withdraw).toHaveCSS("color", "rgb(23, 25, 22)"));
      yield* Effect.tryPromise(() =>
        expect(withdraw).toHaveCSS("background-color", "rgb(240, 180, 174)")
      );
      yield* Effect.tryPromise(() => page.unroute(copyEndpoint));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Consultar prueba", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("region", { name: "Copia de autorización" })).toBeVisible()
      );
      yield* Effect.tryPromise(() => expect(page.getByRole("alert")).toHaveCount(0));
      yield* Effect.tryPromise(() => verifyAccessibility(page));
    })
  );

const verifyRefusalRecovery = (page: Page, original: string): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => page.goto("/app/dashboard"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toContainText("No pudimos autorizar esta acción.")
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Revisar privacidad", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/settings\/privacy$/));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("region", { name: "Constancia de retiro" })).toHaveText(original, {
          useInnerText: true,
        })
      );
    })
  );

const verifyWithdrawnUpgrade = (page: Page): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const enrollmentRequests: Array<string> = [];
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith("/subscription/") || path.startsWith("/web/subscription/")) {
          enrollmentRequests.push(path);
        }
      });
      yield* Effect.tryPromise(() => page.goto("/upgrade"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toContainText("Tu autorización está retirada")
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("link", { name: "Iniciar sesión", exact: true })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toContainText("Tu autorización está retirada")
      );
      expect(enrollmentRequests).toEqual([]);
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Revisar privacidad", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/settings\/privacy$/));
    })
  );

const verifyRenewal = (page: Page): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const renew = page.getByRole("button", { name: "Renovar autorización", exact: true });
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Reintentar aviso", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(renew).toBeDisabled());
      yield* Effect.tryPromise(() =>
        page.getByRole("region", { name: "Renovar autorización" }).getByRole("checkbox").check()
      );
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/web/consent/renew`, (route) => route.fulfill({ status: 503 }), {
          times: 1,
        })
      );
      yield* Effect.tryPromise(() => renew.click());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toContainText("No pudimos confirmar la renovación")
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("region", { name: "Constancia de retiro" })).toBeVisible()
      );
      const response = page.waitForResponse(
        (value) => value.url().endsWith("/web/consent/renew") && value.request().method() === "POST"
      );
      yield* Effect.tryPromise(() => renew.click());
      expect((yield* Effect.tryPromise(() => response)).status()).toBe(successStatus);
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Tu autorización está vigente.", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("button", { name: "Retirar autorización", exact: true })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.goto("/upgrade"));
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Tu autorización está retirada", { exact: true })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("link", { name: "Iniciar sesión", exact: true })).toHaveCount(0)
      );
    })
  );

test("a withdrawn User explicitly renews the saved authorization through real Core and can open Upgrade", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => signInPrivacyRenewalThroughCore({ page, request }));
      yield* Effect.tryPromise(() => page.goto("/settings/privacy"));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/web/consent/authorization`, unavailableResponse, { times: 1 })
      );
      yield* Effect.tryPromise(() => withdrawalCheckbox(page).check());
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Retirar autorización", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("region", { name: "Constancia de retiro" })).toBeVisible()
      );
      yield* Effect.tryPromise(() => verifyRenewal(page));
    })
  ));

test("an expired-trial User withdraws through real Core and can recover the same receipt after ordinary access stops", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => signInPrivacyThroughCore({ page, request }));
      yield* Effect.tryPromise(() => page.goto("/settings/privacy"));
      yield* Effect.tryPromise(() =>
        expect(
          page
            .getByRole("navigation", { name: "Aplicación" })
            .getByRole("link", { name: "Privacidad", exact: true })
        ).toBeVisible()
      );
      const withdraw = page.getByRole("button", { name: "Retirar autorización", exact: true });
      yield* Effect.tryPromise(() => expect(withdraw).toBeDisabled());
      yield* Effect.tryPromise(() => verifyAuthorizationRecovery(page));
      yield* Effect.tryPromise(() => withdrawalCheckbox(page).check());
      yield* Effect.tryPromise(() => withdraw.click());
      const receipt = page.getByRole("region", { name: "Constancia de retiro" });
      yield* Effect.tryPromise(() => expect(receipt).toContainText("Autorización retirada"));
      const original = yield* Effect.tryPromise(() => receipt.innerText());
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() => expect(receipt).toHaveText(original, { useInnerText: true }));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("link", { name: "obarboza@fidyapp.com" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Consultar prueba", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("region", { name: "Copia de autorización" })).toContainText(
          "Versión del aviso:"
        )
      );
      yield* Effect.tryPromise(() =>
        page.getByText("Ver el aviso que autorizaste", { exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("region", { name: "Copia de autorización" })).toContainText(
          "Referencia:"
        )
      );
      yield* Effect.tryPromise(() => verifyTransactionAccess(page));
      yield* Effect.tryPromise(() => verifyWithdrawnUpgrade(page));
      const response = yield* Effect.tryPromise(() =>
        page.request.get(`${apiOrigin}/transactions`, {
          headers: { origin: "https://127.0.0.1:4173" },
        })
      );
      expect(response.status()).toBe(unauthenticatedStatus);
      yield* Effect.tryPromise(() => verifyRefusalRecovery(page, original));
    })
  ));

test("an uncertain withdrawal never claims success or repeats the mutation before checking status", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      let posts = 0;
      yield* Effect.tryPromise(() => page.route(`${apiOrigin}/web/consent`, grantedConsent));
      const refuseWithdrawal = (route: Route): Promise<void> => {
        posts += 1;
        return route.abort("failed");
      };
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/web/consent/withdraw`, refuseWithdrawal)
      );
      yield* Effect.tryPromise(() => page.goto("/settings/privacy"));
      yield* Effect.tryPromise(() => withdrawalCheckbox(page).check());
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Retirar autorización", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toContainText("No pudimos confirmar el resultado")
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("button", { name: "Retirar autorización", exact: true })
        ).toBeDisabled()
      );
      expect(posts).toBe(1);
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("region", { name: "Constancia de retiro" })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Verificar autorización", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(page.getByRole("alert")).toHaveCount(0));
      yield* Effect.tryPromise(() => expect(withdrawalCheckbox(page)).not.toBeChecked());
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("button", { name: "Retirar autorización", exact: true })
        ).toBeDisabled()
      );
      yield* Effect.tryPromise(() => withdrawalCheckbox(page).check());
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("button", { name: "Retirar autorización", exact: true })
        ).toBeEnabled()
      );
      expect(posts).toBe(1);
    })
  ));

const grantedConsent = (route: Route): Promise<void> =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ status: "Granted", withdrawal: null }),
  });

test("privacy retains application navigation and the public contact when the session cannot authorize a read", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => page.route(`${apiOrigin}/web/consent`, refusedConsent));
      yield* Effect.tryPromise(() => page.goto("/settings/privacy"));
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("heading", { name: "Privacidad y tratamiento de datos", exact: true })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("link", { name: "obarboza@fidyapp.com" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Acceso no autorizado", { exact: true })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 853 }));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Menú de navegación" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("link", { name: "Privacidad", exact: true }).filter({ visible: true })
        ).toBeVisible()
      );
      const dimensions = yield* Effect.tryPromise(() => page.evaluate(documentDimensions));
      expect(dimensions.content).toBeLessThanOrEqual(dimensions.width);
      yield* Effect.tryPromise(() => verifyAccessibility(page));
    })
  ));

const refusedConsent = (route: Route): Promise<void> => route.fulfill({ status: 401 });
const documentDimensions = (): Readonly<{ width: number; content: number }> => ({
  width: document.documentElement.clientWidth,
  content: document.documentElement.scrollWidth,
});

const privacyHistoryCount = 101;
const uuidWidth = 12;
const privacyRows = Array.from({ length: privacyHistoryCount }, (_, index) => ({
  id: `26000000-0000-4000-8000-${String(index + 1).padStart(uuidWidth, "0")}`,
  categoryId: "10000000-0000-4000-8000-000000000001",
  money: { amount: "12000", currency: "COP" },
  direction: "outflow",
  counterparty: `Registro privado ${index + 1}`,
  occurredAt: "2026-10-01T12:00:00.000Z",
  createdAt: "2026-10-01T12:00:00.000Z",
  revision: 0,
}));
const installPrivacyHistory = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    let calls = 0;
    yield* Effect.tryPromise(() =>
      page.route(`${apiOrigin}/web/consent`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: "Revoked",
            withdrawal: { reference: "26000000-0000-4000-8000-000000000200", occurredAtMs: 1000 },
          }),
        })
      )
    );
    yield* Effect.tryPromise(() =>
      page.route(`${apiOrigin}/web/privacy/transactions`, (route) => {
        calls += 1;
        if (calls === 2) return route.fulfill({ status: 503 });
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            reference: "26000000-0000-4000-8000-000000000201",
            scope: "transactions",
            presentation: { locale: "es-CO", timeZone: "America/Bogota" },
            categories: [{ id: privacyRows[0]?.categoryId, label: "Restaurantes" }],
            data: calls === 1 ? privacyRows.slice(0, 100) : privacyRows.slice(100),
            next:
              calls === 1
                ? {
                    id: privacyRows[99]?.id,
                    occurredAt: privacyRows[99]?.occurredAt,
                    createdAt: privacyRows[99]?.createdAt,
                  }
                : null,
          }),
        });
      })
    );
  });

test("read-only Transactions retain loaded history through a failed continuation and allow browsing after retry", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* installPrivacyHistory(page);
      yield* Effect.tryPromise(() => page.goto("/app/transactions"));
      const rows = page.getByRole("button", { name: /^Ver transacción Registro privado / });
      yield* Effect.tryPromise(() => expect(rows).toHaveCount(100));
      yield* Effect.tryPromise(() =>
        page.getByLabel("Continuación de transacciones", { exact: true }).scrollIntoViewIfNeeded()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("alert").filter({ hasText: "No pudimos cargar más transacciones" })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() => expect(rows).toHaveCount(100));
      yield* Effect.tryPromise(() =>
        page
          .getByRole("button", { name: "Reintentar carga de más transacciones", exact: true })
          .click()
      );
      yield* Effect.tryPromise(() => expect(rows).toHaveCount(privacyHistoryCount));
      yield* Effect.tryPromise(() =>
        page
          .getByRole("button", { name: "Ver transacción Registro privado 101", exact: true })
          .click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("region", { name: "Detalle de transacción" })).toContainText(
          "Registro privado 101"
        )
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Eliminar transacción", exact: true })).toHaveCount(
          0
        )
      );
    })
  ));

test("an erasure intention uses fresh Core authority and an explicit retry returns the same request", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => signInPrivacyErasureThroughCore({ page, request }));
      yield* Effect.tryPromise(() => page.goto("/settings/privacy"));
      const region = page.getByRole("region", { name: "Solicitud de eliminación" });
      const button = region.getByRole("button", { name: "Solicitar eliminación", exact: true });
      yield* Effect.tryPromise(() => expect(button).toBeDisabled());
      yield* Effect.tryPromise(() => region.getByRole("checkbox").check());
      const first = page.waitForResponse(
        (response) =>
          response.url() === `${apiOrigin}/web/privacy/erasure` &&
          response.request().method() === "POST"
      );
      yield* Effect.tryPromise(() => button.click());
      const response = yield* Effect.tryPromise(() => first);
      expect(response.status()).toBe(acceptedStatus);
      const initial: unknown = yield* Effect.tryPromise(() => response.json());
      yield* Effect.tryPromise(() =>
        expect(region.getByRole("alert")).toContainText("Aún no hemos eliminado tus datos")
      );
      yield* Effect.tryPromise(() => expect(button).toBeDisabled());
      yield* Effect.tryPromise(() => expect(region).not.toContainText("Referencia:"));
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() => region.getByRole("checkbox").check());
      const retry = page.waitForResponse(
        (value) =>
          value.url() === `${apiOrigin}/web/privacy/erasure` && value.request().method() === "POST"
      );
      yield* Effect.tryPromise(() => button.click());
      const repeated = yield* Effect.tryPromise(() => retry);
      expect(repeated.status()).toBe(acceptedStatus);
      expect(yield* Effect.tryPromise(() => repeated.json())).toEqual(initial);
      yield* Effect.tryPromise(() => verifyAccessibility(page));
    })
  ));
