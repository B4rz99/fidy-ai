import type { Page } from "@playwright/test";
import { Effect } from "effect";

export const acceptSubscriptionContracts = Effect.fnUntraced(function* (page: Page) {
  yield* Effect.tryPromise(() =>
    page.getByRole("checkbox", { name: /Acepto el reglamento/iu }).check()
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("checkbox", { name: /Autorizo el tratamiento/iu }).check()
  );
});
