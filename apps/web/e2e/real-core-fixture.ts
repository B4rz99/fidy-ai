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

type SignInFixture = Readonly<{ page: Page; request: APIRequestContext }>;
const signInWithIdentity = ({ page, request }: SignInFixture, firstCard: boolean): Promise<void> =>
  page
    .goto("/auth/pair")
    .then(() => page.getByRole("button", { name: "Iniciar sesión en el navegador" }).click())
    .then(() => visiblePairingCode(page))
    .then((code) =>
      request.post(`http://127.0.0.1:4175/approve?code=${code}&firstCard=${firstCard}`)
    )
    .then((approval) => {
      expect(approval.status()).toBe(noContentStatus);
      return expect(page).toHaveURL(/\/app\/transactions$/u, {
        timeout: pairingTimeoutMilliseconds,
      });
    });

/** Signs in the seeded User with an available CardPaymentSource through real Core redemption. */
export const signInThroughCore = (input: SignInFixture): Promise<void> =>
  signInWithIdentity(input, false);

/** Signs in a separate User whose first Subscription must tokenize a new card. */
export const signInFirstCardThroughCore = (input: SignInFixture): Promise<void> =>
  signInWithIdentity(input, true);
