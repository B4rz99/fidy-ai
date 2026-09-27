import type { APIRequestContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";

const noContentStatus = 204;
const pairingTimeoutMilliseconds = 15_000;

/** The browser obtains a WebSession only from real Core redemption, never from a route mock. */
export const visiblePairingCode = (page: Page): Promise<string> =>
  page
    .locator('[aria-label^="Código de vinculación "]')
    .getAttribute("aria-label")
    .then((label) => {
      const code = label?.replace("Código de vinculación ", "") ?? "";
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u);
      return code;
    });

export const signInThroughCore = ({
  page,
  request,
}: Readonly<{ page: Page; request: APIRequestContext }>): Promise<void> =>
  page
    .goto("/auth/pair")
    .then(() => page.getByRole("button", { name: "Iniciar sesión en el navegador" }).click())
    .then(() => visiblePairingCode(page))
    .then((code) => request.post(`http://127.0.0.1:4175/approve?code=${code}`))
    .then((approval) => {
      expect(approval.status()).toBe(noContentStatus);
      return expect(page).toHaveURL(/\/app\/transactions$/u, {
        timeout: pairingTimeoutMilliseconds,
      });
    });
