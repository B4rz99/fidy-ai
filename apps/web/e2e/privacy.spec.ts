import { Effect, Schema } from "effect";
import { playwright } from "./playwright-runtime";
import { signInPrivacyThroughCore } from "./real-core-fixture";
import type { Page, Route } from "@playwright/test";
import { apiOrigin } from "./http-fixtures";
import { exerciseTitularCase } from "./titular-case-fixture";

const { expect, test } = playwright;
const unauthenticatedStatus = 401;

const verifyTransactionAccess = (page: Page): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Consultar mis transacciones", exact: true }).click()
      );
      const transactionCopy = page.getByRole("region", { name: "Copia de transacciones" });
      yield* Effect.tryPromise(() =>
        expect(transactionCopy).toContainText("Solicitud de acceso de prueba")
      );
      yield* Effect.tryPromise(() =>
        expect(transactionCopy).toContainText("24000000-0000-4000-8000-000000000383")
      );
      yield* Effect.tryPromise(() =>
        expect(transactionCopy).toContainText("Fin de las transacciones disponibles.")
      );
      const referenceText = yield* Effect.tryPromise(() =>
        transactionCopy.getByText("Referencia de consulta:", { exact: false }).innerText()
      );
      const ownerResultRef = yield* Schema.decodeEffect(Schema.String.check(Schema.isUUID()))(
        referenceText.replace("Referencia de consulta: ", "")
      );
      yield* Effect.tryPromise(() => exerciseTitularCase(ownerResultRef));
    })
  );

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
      yield* Effect.tryPromise(() => page.getByRole("checkbox").check());
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
      // Cookie remains usable for privacy, but cannot authorize ordinary canonical work.
      yield* Effect.tryPromise(() => verifyTransactionAccess(page));
      const response = yield* Effect.tryPromise(() =>
        page.request.get(`${apiOrigin}/transactions`, {
          headers: { origin: "https://127.0.0.1:4173" },
        })
      );
      expect(response.status()).toBe(unauthenticatedStatus);
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
      yield* Effect.tryPromise(() => page.getByRole("checkbox").check());
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
        expect(page.getByRole("heading", { name: "Sesión vencida" })).toHaveCount(0)
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
    })
  ));

const refusedConsent = (route: Route): Promise<void> => route.fulfill({ status: 401 });
const documentDimensions = (): Readonly<{ width: number; content: number }> => ({
  width: document.documentElement.clientWidth,
  content: document.documentElement.scrollWidth,
});
