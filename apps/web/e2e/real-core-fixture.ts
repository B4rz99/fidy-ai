import type { APIRequestContext, Page } from "@playwright/test";
import { Clock, Effect } from "effect";
import { playwright } from "./playwright-runtime";

const { expect } = playwright;

const successStatus = 200;
const noContentStatus = 204;
const pairingTimeoutMilliseconds = 15_000;
const firstPollMilliseconds = 5_000;

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
  page.clock
    .install()
    .then(() => page.goto("/auth/pair"))
    .then(() => page.getByRole("button", { name: "Iniciar sesión en el navegador" }).click())
    .then(() => visiblePairingCode(page))
    .then((code) =>
      request.post(`http://127.0.0.1:4175/approve?code=${code}&firstCard=${firstCard}`)
    )
    .then((approval) => {
      expect(approval.status()).toBe(noContentStatus);
      // Advance only the browser's first-poll delay after approval. Core's clock, proof
      // verification, rate limits, and session creation remain real; no pending poll is skipped.
      const redemption = page.waitForResponse("**/web/pairings/redeem");
      return page.clock.fastForward(firstPollMilliseconds).then(() => redemption);
    })
    .then((redemption) => {
      expect(redemption.status()).toBe(successStatus);
      return expect(page).toHaveURL(/\/app\/transactions$/u, {
        timeout: pairingTimeoutMilliseconds,
      });
    })
    .then(() => page.clock.setSystemTime(Effect.runSync(Clock.currentTimeMillis)));

/** Signs in the seeded User with an available CardPaymentSource through real Core redemption. */
export const signInThroughCore = (input: SignInFixture): Promise<void> =>
  signInWithIdentity(input, false);

/** Signs in a separate User whose first Subscription must tokenize a new card. */
export const signInFirstCardThroughCore = (input: SignInFixture): Promise<void> =>
  signInWithIdentity(input, true);
