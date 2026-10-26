import type { Page } from "@playwright/test";
import { Effect } from "effect";

export const acceptSubscriptionContracts = Effect.fnUntraced(function* (page: Page) {
  yield* Effect.tryPromise((signal) =>
    page.getByRole("checkbox", { name: /Acepto el reglamento/iu }).check({ signal })
  );
  yield* Effect.tryPromise((signal) =>
    page.getByRole("checkbox", { name: /Autorizo el tratamiento/iu }).check({ signal })
  );
});
