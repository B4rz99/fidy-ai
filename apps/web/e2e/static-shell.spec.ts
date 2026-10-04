import { AxeBuilder } from "@axe-core/playwright";
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import { type Cause, Effect } from "effect";

const wait = <A>(promise: Promise<A>): Effect.Effect<A, Cause.UnknownError> =>
  Effect.tryPromise(() => promise);
const json = (value: object, space: number): string => JSON.stringify(value, undefined, space);
const waitForEntrances = (page: Page): Promise<Animation[]> =>
  page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
const expectSeriousAccessibilityViolations = (page: Page): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const results = yield* wait(new AxeBuilder({ page }).analyze());
      const seriousViolations = results.violations.filter(
        ({ impact }) => impact === "serious" || impact === "critical"
      );
      expect(seriousViolations, json(seriousViolations, 2)).toEqual([]);
    })
  );
const ok = 200;
const notFound = 404;
const accepted = 204;
const forbidden = 403;
const unauthorized = 401;
const methodNotAllowed = 405;
test("serves the checked-in security policy on SPA fallbacks", ({ request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const shell = yield* wait(request.get("/app/transactions"));
      expect(shell.status()).toBe(ok);
      expect(yield* wait(shell.text())).toContain('id="root"');
      expect(shell.headers()["cache-control"]).toBe("no-cache");
      expect(shell.headers()["content-security-policy"]).toContain(
        "connect-src https://127.0.0.1:4174 https://sandbox.wompi.co https://production.wompi.co;"
      );
      expect(shell.headers()["x-frame-options"]).toBe("DENY");
      expect(shell.headers()["referrer-policy"]).toBe("no-referrer");
    })
  ));
test("keeps hashed assets immutable without relaxing security headers or publishing maps", ({
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const shell = yield* wait(request.get("/"));
      const asset = (yield* wait(shell.text())).match(/\/(assets\/[^"']+\.js)/u)?.[1];
      expect(asset).toMatch(/^assets\/.+-[A-Za-z0-9_-]{8,}\.js$/u);
      const hashed = yield* wait(request.get(`/${asset}`));
      expect(hashed.status()).toBe(ok);
      expect(hashed.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(hashed.headers()["content-security-policy"]).toBe(
        shell.headers()["content-security-policy"]
      );
      expect((yield* wait(request.get(`${asset}.map`))).status()).toBe(notFound);
    })
  ));
test("does not publish an OpenAPI document or source maps as static assets", ({ request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const paths = ["/openapi.json", "/assets/source.js.map"];
      const responses = yield* wait(Promise.all(paths.map((path) => request.get(path))));
      for (const [index, response] of responses.entries()) {
        expect(response.status(), paths[index]).toBe(notFound);
      }
      expect(
        (yield* wait(Promise.all(responses.map((response) => response.text())))).every(
          (body) => !body.includes('id="root"')
        )
      ).toBe(true);
    })
  ));
test("keeps API ownership and credentialed CORS on the real ingress, not the static host", ({
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const api = "https://127.0.0.1:4174";
      const browser = "https://127.0.0.1:4173";
      const headers = {
        origin: browser,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      };
      const preflight = yield* wait(
        request.fetch(`${api}/web/pairings`, {
          method: "OPTIONS",
          headers,
        })
      );
      expect(preflight.status()).toBe(accepted);
      expect(preflight.headers()["access-control-allow-origin"]).toBe(browser);
      expect(preflight.headers()["access-control-allow-credentials"]).toBe("true");
      expect(preflight.headers()["cache-control"]).toBe("no-store");
      const hostile = yield* wait(
        request.fetch(`${api}/web/pairings`, {
          method: "OPTIONS",
          headers: { ...headers, origin: "https://attacker.example" },
        })
      );
      expect(hostile.status()).toBe(forbidden);
      expect(hostile.headers()["access-control-allow-origin"]).toBeUndefined();
      const wrongMethod = yield* wait(
        request.get(`${api}/web/pairings`, { headers: { origin: browser } })
      );
      expect(wrongMethod.status()).toBe(methodNotAllowed);
      expect(wrongMethod.headers().allow).toBe("POST");
      expect((yield* wait(request.post("/web/pairings"))).status()).toBe(methodNotAllowed);
      const staticAuth = yield* wait(request.get("/web/email/authentication/start"));
      expect(staticAuth.status()).toBe(ok);
      expect(staticAuth.headers()["content-type"]).toContain("text/html");
      expect(staticAuth.headers()["set-cookie"]).toBeUndefined();
      expect((yield* wait(request.get(`${api}/openapi.json`))).status()).toBe(notFound);
    })
  ));
const expectUnauthenticated = (request: APIRequestContext, path: string): Promise<void> =>
  request
    .get(`https://127.0.0.1:4174${path}`, { headers: { origin: "https://127.0.0.1:4173" } })
    .then((result) => {
      expect(result.status(), path).toBe(unauthorized);
      expect(result.headers()["cache-control"], path).toBe("no-store");
      expect(result.headers()["set-cookie"], path).toBeUndefined();
    });
test("Core refuses unauthenticated financial routes and untrusted support decisions", ({
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const api = "https://127.0.0.1:4174";
      const headers = { origin: "https://127.0.0.1:4173" };
      const protectedPaths = [
        "/categories",
        "/transactions",
        "/dashboard/view",
        "/subscription/status",
      ];
      yield* wait(Promise.all(protectedPaths.map((path) => expectUnauthenticated(request, path))));
      const support = yield* wait(
        request.post(`${api}/internal/support-recovery`, {
          headers,
          data: { pairingCode: "BCDF-GHJK", backupRecoveryCode: "invalid" },
        })
      );
      expect(support.status()).toBe(forbidden);
      expect(support.headers()["access-control-allow-origin"]).toBeUndefined();
    })
  ));
test("renders the public home route without serious accessibility violations", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(page.goto("/"));
      yield* wait(expect(page).toHaveTitle("Fidy — Tu plata, más clara"));
      yield* wait(
        expect(
          page.getByRole("heading", {
            level: 1,
            name: "Tu plata, más clara. Tu vida, más tranquila.",
          })
        ).toBeVisible()
      );
      yield* wait(waitForEntrances(page));
      yield* wait(expectSeriousAccessibilityViolations(page));
    })
  ));
test("renders the policy route without serious accessibility violations", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(page.goto("/politica"));
      yield* wait(
        expect(
          page.getByRole("heading", {
            level: 1,
            name: "Política de tratamiento de datos personales",
          })
        ).toBeVisible()
      );
      yield* wait(expectSeriousAccessibilityViolations(page));
    })
  ));
test("renders not-found behavior without serious accessibility violations", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(page.goto("/ruta-inexistente"));
      yield* wait(
        expect(page.getByRole("heading", { name: "Página no encontrada" })).toBeVisible()
      );
      yield* wait(expectSeriousAccessibilityViolations(page));
    })
  ));
