import type { Page, Response } from "@playwright/test";
import { Effect } from "effect";
import { settleAcceptanceClock } from "./acceptance-clock";
import { playwright } from "./playwright-runtime";

const { expect } = playwright;
const successStatus = 200;
const resourceLimitedStatus = 429;
const maximumReadRetries = 6;

/** Pace explicit read recovery against real Core pressure; never retry a decision mutation. */
const readPrivacyThroughCore = ({
  page,
  path,
  initial,
  retry,
}: Readonly<{
  page: Page;
  path: "/web/consent" | "/web/consent/authorization" | "/web/privacy/transactions";
  initial: () => Promise<unknown>;
  retry: () => Promise<void>;
}>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const method = path === "/web/privacy/transactions" ? "POST" : "GET";
      const read = (action: () => Promise<unknown>): Promise<Response> =>
        Promise.all([
          page
            .waitForRequest(
              (request) => request.url().endsWith(path) && request.method() === method
            )
            .then((request) => request.response())
            .then((response) => {
              if (response === null) throw new Error("Expected the privacy read response");
              return response;
            }),
          action(),
        ]).then(([response]) => response);
      let response = yield* Effect.tryPromise(() => read(initial));
      for (
        let attempt = 0;
        response.status() === resourceLimitedStatus && attempt < maximumReadRetries;
        attempt++
      ) {
        yield* Effect.tryPromise(() => response.finished());
        yield* Effect.tryPromise(() => settleAcceptanceClock(page));
        response = yield* Effect.tryPromise(() => read(retry));
      }
      expect(response.status()).toBe(successStatus);
    }).pipe(Effect.timeout("15 seconds"))
  );

/** Reload the actual privacy view, recovering only a refused status read through its control. */
export const reloadPrivacyThroughCore = (page: Page): Promise<void> =>
  readPrivacyThroughCore({
    page,
    path: "/web/consent",
    initial: () => page.reload(),
    retry: () => page.getByRole("button", { name: "Verificar autorización", exact: true }).click(),
  });

/** Return from an ordinary access refusal using the public privacy recovery link. */
export const reopenPrivacyThroughCore = (page: Page): Promise<void> =>
  readPrivacyThroughCore({
    page,
    path: "/web/consent",
    initial: () => page.getByRole("link", { name: "Revisar privacidad", exact: true }).click(),
    retry: () => page.getByRole("button", { name: "Verificar autorización", exact: true }).click(),
  });

/** Upgrade has its own status gate and retry control, including after a reload. */
export const reloadUpgradeThroughCore = (page: Page): Promise<void> =>
  readPrivacyThroughCore({
    page,
    path: "/web/consent",
    initial: () => page.reload(),
    retry: () => page.getByRole("button", { name: "Reintentar", exact: true }).click(),
  });

/** Retrieve the saved authorization through the visible read control, including after withdrawal. */
export const consultAuthorizationThroughCore = (page: Page): Promise<void> => {
  const consult = (): Promise<void> =>
    page.getByRole("button", { name: "Consultar prueba", exact: true }).click();
  return readPrivacyThroughCore({
    page,
    path: "/web/consent/authorization",
    initial: consult,
    retry: consult,
  });
};

/** Open the independent read-only history, retrying only a refused history read. */
export const openPrivacyTransactionsThroughCore = (page: Page): Promise<void> => {
  const retry = (): Promise<void> =>
    page.getByRole("button", { name: "Reintentar", exact: true }).click();
  return readPrivacyThroughCore({
    page,
    path: "/web/privacy/transactions",
    initial: () => page.getByRole("link", { name: "Ver mis transacciones", exact: true }).click(),
    retry,
  });
};
