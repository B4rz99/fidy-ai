import type { Locator, Page, Response } from "@playwright/test";
import { Effect, Option } from "effect";
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
  retry: Locator;
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
      let latest = Option.none<Response>();
      const observe = (response: Response): void => {
        if (response.url().endsWith(path) && response.request().method() === method) {
          latest = Option.some(response);
        }
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => page.on("response", observe)),
        () => Effect.sync(() => page.off("response", observe))
      );
      const first = yield* Effect.tryPromise(() => read(initial));
      for (let attempt = 0; attempt < maximumReadRetries; attempt++) {
        const response = Option.getOrElse(latest, () => first);
        if (response.status() !== resourceLimitedStatus) {
          expect(response.status()).toBe(successStatus);
          return;
        }
        if (yield* Effect.tryPromise(() => retry.isVisible())) {
          yield* Effect.tryPromise(() => retry.click());
        }
        yield* Effect.sleep("1 second");
      }
      expect(Option.getOrElse(latest, () => first).status()).toBe(successStatus);
    }).pipe(Effect.scoped, Effect.timeout("15 seconds"))
  );

/** Reload the actual privacy view, recovering only a refused status read through its control. */
export const reloadPrivacyThroughCore = (page: Page): Promise<void> =>
  readPrivacyThroughCore({
    page,
    path: "/web/consent",
    initial: () => page.reload(),
    retry: page.getByRole("button", { name: "Verificar autorización", exact: true }),
  });

/** Return from an ordinary access refusal using the public privacy recovery link. */
export const reopenPrivacyThroughCore = (page: Page): Promise<void> =>
  readPrivacyThroughCore({
    page,
    path: "/web/consent",
    initial: () => page.getByRole("link", { name: "Revisar privacidad", exact: true }).click(),
    retry: page.getByRole("button", { name: "Verificar autorización", exact: true }),
  });

/** Upgrade has its own status gate and retry control, including after a reload. */
export const reloadUpgradeThroughCore = (page: Page): Promise<void> =>
  readPrivacyThroughCore({
    page,
    path: "/web/consent",
    initial: () => page.reload(),
    retry: page.getByRole("button", { name: "Reintentar", exact: true }),
  });

/** Retrieve the saved authorization through the visible read control, including after withdrawal. */
export const consultAuthorizationThroughCore = (page: Page): Promise<void> => {
  const consult = (): Promise<void> =>
    page.getByRole("button", { name: "Consultar prueba", exact: true }).click();
  return readPrivacyThroughCore({
    page,
    path: "/web/consent/authorization",
    initial: consult,
    retry: page.getByRole("button", { name: "Consultar prueba", exact: true }),
  });
};

/** Open the independent read-only history, retrying only a refused history read. */
export const openPrivacyTransactionsThroughCore = (page: Page): Promise<void> => {
  const retry = page.getByRole("button", { name: "Reintentar", exact: true });
  return readPrivacyThroughCore({
    page,
    path: "/web/privacy/transactions",
    initial: () => page.getByRole("link", { name: "Ver mis transacciones", exact: true }).click(),
    retry,
  });
};

/** Reload read-only history through its independent Privacy authority. */
export const reloadPrivacyTransactionsThroughCore = (page: Page): Promise<void> =>
  readPrivacyThroughCore({
    page,
    path: "/web/privacy/transactions",
    initial: () => page.reload(),
    retry: page.getByRole("button", { name: "Reintentar", exact: true }),
  });
