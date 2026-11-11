import { retainedSecretCount } from "./browser-storage-fixture";
import { Effect, Redacted, Schema } from "effect";
import { StartedBrowserLoginPairing } from "@fidy/server/client";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";
import { installAcceptanceClock } from "./acceptance-clock";
import type { APIRequestContext, Page, Route } from "@playwright/test";
import { playwright } from "./playwright-runtime";

const { test, expect } = playwright;
const rotationPattern = "**/recovery/backup-code/rotate";
const successStatus = 200;
const acceptedStatus = 202;
const noContentStatus = 204;
const openRecoveryThroughCore = ({
  page,
  request,
  email,
}: Readonly<{ page: Page; request: APIRequestContext; email: string }>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const topology = browserAcceptanceTopology();
      const headers = { origin: topology.app };
      const started = yield* Effect.tryPromise(() =>
        page.request.post(`${topology.api}/web/pairings`, { headers })
      );
      expect(started.status()).toBe(successStatus);
      const pairing = yield* Effect.tryPromise(() =>
        started
          .json()
          .then(Schema.decodeUnknownPromise(Schema.toCodecJson(StartedBrowserLoginPairing)))
      );
      const proof = {
        pairingId: pairing.pairingId,
        privateVerifier: Redacted.value(pairing.privateVerifier),
      };
      const pending = yield* Effect.tryPromise(() =>
        page.request.post(`${topology.api}/web/email/authentication/start`, {
          headers,
          data: { ...proof, email },
        })
      );
      expect(pending.status()).toBe(acceptedStatus);
      const delivered = yield* Effect.tryPromise(() =>
        request.post(`${topology.operator}/email/login/deliver?code=${pairing.publicCode}`)
      );
      expect(delivered.status()).toBe(noContentStatus);
      const completed = yield* Effect.tryPromise(() =>
        page.request.post(`${topology.api}/web/email/authentication/complete`, {
          headers,
          data: { ...proof, combinedCode: `${pairing.publicCode}-JKLM-NPQR-STUV-WXYZ` },
        })
      );
      expect(completed.status()).toBe(successStatus);
      const redeemed = yield* Effect.tryPromise(() =>
        page.request.post(`${topology.api}/web/pairings/redeem`, { headers, data: proof })
      );
      expect(redeemed.status()).toBe(successStatus);
      yield* Effect.tryPromise(() => installAcceptanceClock(page));
      yield* Effect.tryPromise(() => page.goto("/settings/account"));
    })
  );
const denyClipboard = (): void => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (): Promise<void> => Promise.reject(new Error("clipboard denied")),
      readText: (): Promise<string> => Promise.resolve(""),
    },
  });
};
const leaveDocument = (): boolean => window.dispatchEvent(new PageTransitionEvent("pagehide"));
const finishCopy = (): boolean => window.dispatchEvent(new Event("finish-recovery-copy"));
const pendingClipboard = (): void => {
  let value = "";
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      readText: (): Promise<string> => Promise.resolve(value),
      writeText: (next: string): Promise<void> => {
        value = next;
        if (next === "") return Promise.resolve();
        const pending = Promise.withResolvers<void>();
        window.addEventListener("finish-recovery-copy", () => pending.resolve(), { once: true });
        return pending.promise;
      },
    },
  });
};
const startRotation = (page: Page): Promise<void> =>
  page
    .getByRole("button", { name: "Crear un código nuevo" })
    .click()
    .then(() => page.getByRole("button", { name: "Confirmar código nuevo" }).click());
const loseRotation =
  (mode: "lost" | "malformed", observe: () => void) =>
  (route: Route): Promise<void> => {
    observe();
    return route.fetch().then((response) => {
      expect(response.status()).toBe(successStatus);
      return mode === "lost"
        ? route.abort("failed")
        : route.fulfill({ response, body: '{"data":{"status":"rotated"}}' });
    });
  };
const holdRotation = (
  page: Page
): Promise<Readonly<{ started: Promise<void>; finish: () => Promise<void> }>> => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const pending: Array<Promise<void>> = [];
  const hold = (route: Route): Promise<void> => {
    const completion = route.fetch().then((response) => {
      expect(response.status()).toBe(successStatus);
      started.resolve();
      return release.promise.then(() => route.fulfill({ response }));
    });
    pending.push(completion);
    return completion;
  };
  return page.route(rotationPattern, hold).then(() => ({
    started: started.promise,
    finish: () => {
      release.resolve();
      return Promise.all(pending).then(() => page.unroute(rotationPattern, hold));
    },
  }));
};
const confirmTwice = (button: HTMLButtonElement): void => {
  button.click();
  button.click();
};

const revisitUncertainRecovery = (page: Page): Promise<void> =>
  page
    .getByRole("link", { name: "Accesos", exact: true })
    .first()
    .click()
    .then(() => page.getByRole("link", { name: "Cuenta", exact: true }).first().click())
    .then(() =>
      expect(page.getByText("No pudimos confirmar el código nuevo.", { exact: true })).toBeVisible({
        timeout: 5_000,
      })
    )
    .then(() => expect(page.getByRole("button", { name: "Crear un código nuevo" })).toHaveCount(0))
    .then(() =>
      expect(page.getByRole("button", { name: "Confirmar código nuevo" })).toHaveCount(0)
    );

test("discloses a real rotated recovery code only in its mounted settings view", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        openRecoveryThroughCore({
          page,
          request,
          email: "recovery-disclosure@example.com",
        })
      );
      yield* Effect.tryPromise(() => page.addInitScript(denyClipboard));
      yield* Effect.tryPromise(() => page.goto("/settings/account"));
      let rotations = 0;
      page.on("request", (outgoing) => {
        if (outgoing.url().endsWith("/recovery/backup-code/rotate")) rotations += 1;
      });
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Crear un código nuevo" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Confirmar código nuevo" })).toBeVisible()
      );
      expect(rotations).toBe(0);
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Cancelar" }).click());
      expect(rotations).toBe(0);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Crear un código nuevo" }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Confirmar código nuevo" }).evaluate(confirmTwice)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Guárdalo ahora", { exact: true })).toBeVisible()
      );
      expect(rotations).toBe(1);
      yield* Effect.tryPromise(() =>
        expect(page.locator("code")).toHaveText(/^[A-Z2-9]{5}(?:-[A-Z2-9]{5}){4}$/u)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Copiar código" })).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Copiar código" }).click());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Copiado", exact: true })).toHaveCount(0)
      );
      const code = yield* Effect.tryPromise(() => page.locator("code").textContent());
      expect(code).not.toBeNull();
      expect(page.url()).not.toContain(code);
      yield* Effect.tryPromise(() => page.goto("/app/transactions"));
      yield* Effect.tryPromise(() => page.goto("/settings/account"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Crear un código nuevo" })).toBeVisible()
      );
      yield* Effect.tryPromise(() => expect(page.locator("code")).toHaveCount(0));
      expect(yield* Effect.tryPromise(() => page.evaluate(retainedSecretCount))).toBe(0);
    })
  ));

for (const mode of ["lost", "malformed"] as const) {
  test(`a ${mode} committed recovery rotation ${mode === "lost" ? "stays uncertain until a fresh sign-in" : "exposes uncertainty without retry"}`, ({
    page,
    request,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() =>
          openRecoveryThroughCore({
            page,
            request,
            email: `recovery-${mode}@example.com`,
          })
        );
        let rotations = 0;
        const observeRotation = (): void => {
          rotations += 1;
        };
        yield* Effect.tryPromise(() =>
          page.route(rotationPattern, loseRotation(mode, observeRotation))
        );
        yield* Effect.tryPromise(() => startRotation(page));
        yield* Effect.tryPromise(() =>
          expect(
            page.getByText("No pudimos confirmar el código nuevo.", { exact: true })
          ).toBeVisible()
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("link", { name: "Iniciar sesión", exact: true })).toHaveAttribute(
            "href",
            "/login?resume=account"
          )
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("button", { name: "Intentar de nuevo" })).toHaveCount(0)
        );
        yield* Effect.tryPromise(() => expect(page.locator("code")).toHaveCount(0));
        expect(rotations).toBe(1);
        expect(yield* Effect.tryPromise(() => page.evaluate(retainedSecretCount))).toBe(0);
        // Both failures normalize to the same parameterless onUncertain transition.
        if (mode === "malformed") return;
        yield* Effect.tryPromise(() => revisitUncertainRecovery(page));
        expect(rotations).toBe(1);
        yield* Effect.tryPromise(() => page.unroute(rotationPattern));
        yield* Effect.tryPromise(() =>
          page.getByRole("link", { name: "Iniciar sesión", exact: true }).click()
        );
        yield* Effect.tryPromise(() =>
          openRecoveryThroughCore({
            page,
            request,
            email: `recovery-${mode}@example.com`,
          })
        );
        yield* Effect.tryPromise(() => startRotation(page));
        yield* Effect.tryPromise(() =>
          expect(page.getByText("Guárdalo ahora", { exact: true })).toBeVisible()
        );
      })
    ));
}

test("leaving during rotation retains uncertainty when the settings task remounts", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        openRecoveryThroughCore({
          page,
          request,
          email: "recovery-disposal@example.com",
        })
      );
      const held = yield* Effect.tryPromise(() => holdRotation(page));
      yield* Effect.tryPromise(() => startRotation(page));
      yield* Effect.tryPromise(() => held.started);
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Accesos", exact: true }).first().click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Cuenta", exact: true }).first().click()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByText("No pudimos confirmar el código nuevo.", { exact: true })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() => held.finish());
      yield* Effect.tryPromise(() => expect(page.locator("code")).toHaveCount(0));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Crear un código nuevo" })).toHaveCount(0)
      );
    })
  ));

test("leaving the document fences a late committed rotation response", ({ page, request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        openRecoveryThroughCore({
          page,
          request,
          email: "recovery-disposal@example.com",
        })
      );
      const held = yield* Effect.tryPromise(() => holdRotation(page));
      yield* Effect.tryPromise(() => startRotation(page));
      yield* Effect.tryPromise(() => held.started);
      yield* Effect.tryPromise(() => page.evaluate(leaveDocument));
      yield* Effect.tryPromise(() => held.finish());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Creando código…" })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() => expect(page.locator("code")).toHaveCount(0));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Copiar código" })).toHaveCount(0)
      );
      expect(yield* Effect.tryPromise(() => page.evaluate(retainedSecretCount))).toBe(0);
    })
  ));

test("an old Copy completion cannot replace a new mounted recovery disclosure", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => page.addInitScript(pendingClipboard));
      yield* Effect.tryPromise(() =>
        openRecoveryThroughCore({ page, request, email: "recovery-copy@example.com" })
      );
      yield* Effect.tryPromise(() => startRotation(page));
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Copiar código" }).click());
      const oldCode = yield* Effect.tryPromise(() => page.locator("code").innerText());
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Transacciones", exact: true }).first().click()
      );
      yield* Effect.tryPromise(() =>
        page
          .getByRole("navigation", { name: "Aplicación" })
          .getByText("Ajustes", { exact: true })
          .click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Cuenta", exact: true }).first().click()
      );
      yield* Effect.tryPromise(() => expect(page.locator("code")).toHaveCount(0));
      yield* Effect.tryPromise(() => startRotation(page));
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Copiar código" }).waitFor());
      const currentCode = yield* Effect.tryPromise(() => page.locator("code").innerText());
      expect(currentCode).not.toBe(oldCode);
      yield* Effect.tryPromise(() => page.evaluate(finishCopy));
      yield* Effect.tryPromise(() => expect(page.locator("code")).toHaveText(currentCode));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Copiado", exact: true })).toHaveCount(0)
      );
      expect(yield* Effect.tryPromise(() => page.evaluate(retainedSecretCount))).toBe(0);
    })
  ));
