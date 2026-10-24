import type { Page } from "@playwright/test";
import { type Cause, Config, Effect, Schema } from "effect";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";
import { openBrowserLogin } from "./real-core-fixture";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;
const { AxeBuilder } = await import("@axe-core/playwright");
const wait = <A>(promise: Promise<A>): Effect.Effect<A, Cause.UnknownError> =>
  Effect.tryPromise(() => promise);
const apiOrigin = browserAcceptanceTopology().api;
const captureDirectory = Effect.runSync(
  Config.String("FIDY_LOGIN_CAPTURE_DIRECTORY").pipe(Config.withDefault("/tmp/fidy-login-captures"))
);
const frozenTime = "2026-10-23T12:00:00.000Z";
const initialTime = "2026-10-22T12:00:00.000Z";
const expiresAt = "2026-10-23T12:10:00.000Z";
const pairingLifetimeMilliseconds = 600_000;
const firstPollMilliseconds = 5_000;
const settleMilliseconds = 1_000;
const pollingIntervalSeconds = 5;
const emailCooldownSeconds = 60;
const successStatus = 200;
const pendingStatus = 202;
const invalidStatus = 400;
const opaqueProofLength = 43;
const pairingId = "24000000-0000-4000-8000-000000000240";
const privateVerifier = "v".repeat(opaqueProofLength);
const publicCode = "BCDF-GHJK";
const emailAddress = "usuario@example.com";
const emailCode = "ABCD-EFGH-JKLM-NPQR-STUV-WXYZ";
const desktopWidth = 1440;
const desktopHeight = 900;
const mobileWidth = 390;
const mobileHeight = 844;
const viewports = [
  { width: desktopWidth, height: desktopHeight },
  { width: mobileWidth, height: mobileHeight },
];
const themes = ["light", "dark"] as const;
const views = [
  "principal",
  "email",
  "email-code",
  "wa",
  "email-error",
  "wa-expired",
  "wa-refused",
] as const;
type LoginView = (typeof views)[number];
type CaptureScenario = Readonly<{
  view: LoginView;
  theme: (typeof themes)[number];
  viewport: (typeof viewports)[number];
}>;
type FixtureCounts = { starts: number; emails: number; completions: number; redeems: number };

test.use({
  storageState: { cookies: [], origins: [] },
  deviceScaleFactor: 1,
  launchOptions: { args: ["--ignore-certificate-errors", "--force-color-profile=srgb"] },
});

const installPairingRoutes = (page: Page, view: LoginView): Promise<FixtureCounts> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const counts = { starts: 0, emails: 0, completions: 0, redeems: 0 };
      yield* wait(
        page.route(`${apiOrigin}/web/pairings`, (route) => {
          counts.starts += 1;
          return route.fulfill({
            status: successStatus,
            json: { pairingId, privateVerifier, publicCode, expiresAt, pollingIntervalSeconds },
          });
        })
      );
      yield* wait(
        page.route(`${apiOrigin}/web/pairings/redeem`, (route) => {
          counts.redeems += 1;
          return route.fulfill(
            view === "wa-refused"
              ? {
                  status: invalidStatus,
                  json: {
                    error: {
                      code: "pairing_invalid",
                      message: "Esta vinculación ya no es válida. Inicia de nuevo.",
                    },
                  },
                }
              : {
                  status: pendingStatus,
                  json: { status: "pending_approval", expiresAt, pollingIntervalSeconds },
                }
          );
        })
      );
      yield* wait(
        page.route(`${apiOrigin}/web/email/authentication/start`, (route) => {
          counts.emails += 1;
          return route.fulfill({
            status: pendingStatus,
            json: { status: "pending", retryAfterSeconds: emailCooldownSeconds },
          });
        })
      );
      yield* wait(
        page.route(`${apiOrigin}/web/email/authentication/complete`, (route) => {
          counts.completions += 1;
          return route.fulfill({
            status: invalidStatus,
            json: {
              error: { code: "email_authentication_invalid", message: "El código no es válido." },
            },
          });
        })
      );
      return counts;
    })
  );

const openEmailView = (page: Page, view: LoginView): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(page.getByRole("button", { name: "Correo verificado", exact: true }).click());
      yield* wait(expect(page.getByRole("heading", { name: "Entra con tu correo" })).toBeVisible());
      if (view === "email") return;
      yield* wait(page.getByLabel("Correo verificado").fill(emailAddress));
      yield* wait(page.getByRole("button", { name: "Enviar código", exact: true }).click());
      yield* wait(expect(page.getByRole("heading", { name: "Revisa tu correo" })).toBeVisible());
      if (view !== "email-error") return;
      yield* wait(page.getByLabel("Código del correo").fill(emailCode));
      yield* wait(page.getByRole("button", { name: "Confirmar y entrar", exact: true }).click());
      yield* wait(
        expect(page.getByRole("alert")).toHaveText(
          "No pudimos validar ese código. Revísalo o solicita uno nuevo."
        )
      );
    })
  );

const openWhatsAppView = (page: Page, view: LoginView): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(page.getByRole("button", { name: "WhatsApp", exact: true }).click());
      yield* wait(expect(page.getByText(publicCode, { exact: true })).toBeVisible());
      if (view === "wa-expired") {
        yield* wait(page.clock.fastForward(pairingLifetimeMilliseconds));
        yield* wait(expect(page.getByRole("heading", { name: "El código venció" })).toBeVisible());
      }
      if (view === "wa-refused") {
        yield* wait(page.clock.fastForward(firstPollMilliseconds));
        yield* wait(
          expect(page.getByRole("heading", { name: "Acceso no autorizado" })).toBeVisible()
        );
      }
    })
  );

const waitForRendering = (): Promise<ReadonlyArray<Animation>> =>
  document.fonts.ready.then(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().iterations))
        .map((animation) => animation.finished)
    )
  );

const inspectCapture = (page: Page): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(page.clock.runFor(settleMilliseconds));
      yield* wait(page.evaluate(waitForRendering));
      expect(
        yield* wait(page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      ).toBe(true);
      expect(
        yield* wait(
          page.evaluate(() =>
            Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0)
          )
        )
      ).toBe(true);
      expect(
        yield* wait(
          page.evaluate((proof) => document.body.innerText.includes(proof), privateVerifier)
        )
      ).toBe(false);
    })
  );

const expectFixtureCounts = (counts: FixtureCounts, view: LoginView): void => {
  expect(counts.starts).toBe(view === "principal" || view === "email" ? 0 : 1);
  expect(counts.emails).toBe(view === "email-code" || view === "email-error" ? 1 : 0);
  expect(counts.completions).toBe(view === "email-error" ? 1 : 0);
  if (view === "wa-refused") expect(counts.redeems).toBe(1);
};

const auditLogin = (page: Page, scenario: CaptureScenario): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(page.clock.resume());
      const result = yield* wait(new AxeBuilder({ page }).analyze());
      const report = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        violations: result.violations,
      });
      expect(report.includes(privateVerifier)).toBe(false);
      yield* wait(
        Bun.write(
          `${captureDirectory}/${scenario.view}-${scenario.theme}-${scenario.viewport.width}.axe.json`,
          report
        )
      );
    })
  );

const captureLogin = (page: Page, scenario: CaptureScenario): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(page.setViewportSize(scenario.viewport));
      yield* wait(page.emulateMedia({ colorScheme: scenario.theme }));
      yield* wait(page.clock.install({ time: initialTime }));
      yield* wait(page.clock.pauseAt(frozenTime));
      const counts = yield* wait(installPairingRoutes(page, scenario.view));
      yield* wait(openBrowserLogin(page));
      yield* wait(expect(page.getByRole("heading", { name: "Entra a tu Fidy" })).toBeVisible());
      yield* wait(
        expect(
          page.getByRole("button", {
            name: scenario.theme === "dark" ? "Activar tema claro" : "Activar tema oscuro",
          })
        ).toBeVisible()
      );
      if (scenario.view.startsWith("email")) yield* wait(openEmailView(page, scenario.view));
      if (scenario.view.startsWith("wa")) yield* wait(openWhatsAppView(page, scenario.view));
      yield* wait(inspectCapture(page));
      expectFixtureCounts(counts, scenario.view);
      yield* wait(
        page.screenshot({
          path: `${captureDirectory}/${scenario.view}-${scenario.theme}-${scenario.viewport.width}.png`,
          fullPage: false,
          animations: "allow",
          caret: "hide",
          scale: "css",
          type: "png",
        })
      );
      yield* wait(auditLogin(page, scenario));
    })
  );

const scenarios = views.flatMap((view) =>
  themes.flatMap((theme) =>
    viewports.map((viewport): CaptureScenario => ({ view, theme, viewport }))
  )
);
for (const scenario of scenarios) {
  test(`captures ${scenario.view} in ${scenario.theme} at ${scenario.viewport.width}px`, ({
    page,
  }) => captureLogin(page, scenario));
}

const pendingProviderPage = "<p>Pending provider decision</p>";
type ProviderCapture = Readonly<{
  provider: "google" | "microsoft";
  theme: (typeof themes)[number];
  viewport: (typeof viewports)[number];
}>;
const captureProviderCancellation = (page: Page, scenario: ProviderCapture): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { provider, theme, viewport } = scenario;
      yield* wait(page.setViewportSize(viewport));
      yield* wait(page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" }));
      yield* wait(
        page.context().setExtraHTTPHeaders({ "x-acceptance-source": test.info().testId })
      );
      const pattern =
        provider === "google"
          ? "https://accounts.google.com/o/oauth2/v2/auth**"
          : "https://login.microsoftonline.com/common/oauth2/v2.0/authorize**";
      yield* wait(
        page
          .context()
          .route(pattern, (route) =>
            route.fulfill({ status: 200, contentType: "text/html", body: pendingProviderPage })
          )
      );
      yield* wait(page.goto("/login"));
      const [popup] = yield* wait(
        Promise.all([
          page.waitForEvent("popup"),
          page
            .getByRole("button", {
              name: `Continuar con ${provider === "google" ? "Google" : "Microsoft"}`,
            })
            .click(),
        ])
      );
      yield* wait(expect(popup.getByText("Pending provider decision")).toBeVisible());
      yield* wait(popup.close());
      yield* wait(expect(page.getByRole("alert")).toHaveText("Cancelaste el acceso."));
      yield* wait(
        expect(page.getByRole("button", { name: "Opciones de inicio de sesión" })).toBeVisible()
      );
      yield* wait(page.evaluate(() => document.fonts.ready));
      const filename = `${captureDirectory}/${provider}-cancelled-${theme}-${viewport.width}`;
      yield* wait(page.screenshot({ path: `${filename}.png`, scale: "css", caret: "hide" }));
      const audit = yield* wait(new AxeBuilder({ page }).analyze());
      expect(audit.violations).toEqual([]);
      const report = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        violations: audit.violations,
      });
      yield* wait(Bun.write(`${filename}.axe.json`, report));
    })
  );
for (const provider of ["google", "microsoft"] as const) {
  for (const theme of themes) {
    for (const viewport of viewports) {
      test(`feedback ${provider} cancelled ${theme} ${viewport.width}`, ({ page }) =>
        captureProviderCancellation(page, { provider, theme, viewport }));
    }
  }
}
for (const theme of themes) {
  test(`feedback back hover ${theme}`, ({ page }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* wait(page.setViewportSize({ width: desktopWidth, height: desktopHeight }));
        yield* wait(page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" }));
        yield* wait(page.goto("/login"));
        yield* wait(page.getByRole("button", { name: "Correo verificado", exact: true }).click());
        const back = page.getByRole("button", { name: "Opciones de inicio de sesión" });
        yield* wait(back.hover());
        yield* wait(expect(back).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)"));
        yield* wait(page.evaluate(() => document.fonts.ready));
        yield* wait(
          page.screenshot({
            path: `${captureDirectory}/back-hover-${theme}-1440.png`,
            scale: "css",
            caret: "hide",
          })
        );
      })
    ));
}
