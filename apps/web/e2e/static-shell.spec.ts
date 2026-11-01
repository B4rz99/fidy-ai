import { analyzeAccessibility } from "./accessibility";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";
import { AxeBuilder } from "@axe-core/playwright";
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import { type Cause, DateTime, Effect } from "effect";

const topology = browserAcceptanceTopology();

const wait = <A>(promise: Promise<A>): Effect.Effect<A, Cause.UnknownError> =>
  Effect.tryPromise(() => promise);

for (const provider of ["google", "microsoft"] as const) {
  test(`${provider} return closes without loading application code or reading a session`, ({
    page,
    context,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const reads: Array<string> = [];
        yield* wait(
          context.route(`${topology.api}/**`, (route) => {
            reads.push(new URL(route.request().url()).pathname);
            return route.abort("blockedbyclient");
          })
        );
        yield* wait(
          context.route(/\/assets\/(?:render|initial-session)-[^/]+\.js$/u, (route) =>
            route.abort("blockedbyclient")
          )
        );
        yield* wait(
          page.setContent(
            `<a href="${topology.app}/auth/${provider}-return" target="_blank" rel="noopener">Return</a>`
          )
        );
        const popup = page.waitForEvent("popup");
        yield* wait(page.getByRole("link", { name: "Return", exact: true }).click());
        const opened = yield* wait(popup);
        yield* wait(expect.poll(() => opened.isClosed()).toBe(true));
        expect(reads).toEqual([]);
      })
    ));
}

const json = (value: object, space: number): string => JSON.stringify(value, undefined, space);
const expectSeriousAccessibilityViolations = (page: Page): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const results = yield* wait(analyzeAccessibility(page));
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
const inaccessibleDocument =
  '<!doctype html><html lang="en"><head><title>Accessibility fixture</title></head><body><main><h1>Example</h1><button id="missing-name"></button></main></body></html>';
const accessibilityTargets = (
  result: Awaited<ReturnType<typeof analyzeAccessibility>>
): ReadonlyArray<string> =>
  result.violations
    .flatMap(({ id, nodes }) => nodes.map((node) => `${id}:${JSON.stringify(node.target)}`))
    .sort();

const addShadowAccessibilityControl = (): void => {
  const region = document.createElement("section");
  region.attachShadow({ mode: "open" }).innerHTML = '<button id="shadow-missing-name"></button>';
  document.querySelector("main")?.append(region);
};
test("accessibility retains every result and shadow control while the application clock is paused", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(page.setContent(inaccessibleDocument));
      yield* wait(page.evaluate(addShadowAccessibilityControl));
      yield* wait(page.evaluate('document.documentElement.dataset.clockProbe = "waiting"'));
      const expected = yield* wait(new AxeBuilder({ page }).analyze());
      const time = DateTime.toDateUtc(DateTime.makeUnsafe("2026-10-25T12:00:00Z"));
      yield* wait(page.clock.install({ time }));
      yield* wait(page.clock.pauseAt(time));
      yield* wait(
        page.evaluate(`
        setTimeout(() => document.documentElement.dataset.clockProbe = "advanced", 10);
      `)
      );
      const actual = yield* wait(analyzeAccessibility(page));
      expect(actual.testEngine).toEqual(expected.testEngine);
      expect(actual.testRunner).toEqual(expected.testRunner);
      expect(actual.testEnvironment).toEqual(expected.testEnvironment);
      expect(actual.url).toBe(expected.url);
      for (const group of ["violations", "passes", "incomplete", "inapplicable"] as const) {
        expect(actual[group]).toEqual(expected[group]);
      }
      expect(accessibilityTargets(actual)).toEqual(accessibilityTargets(expected));
      expect(accessibilityTargets(actual)).toContain('button-name:["#missing-name"]');
      expect(accessibilityTargets(actual)).toContain(
        'button-name:[["section","#shadow-missing-name"]]'
      );
      expect(yield* wait(page.evaluate<number>("Date.now()"))).toBe(time.getTime());
      expect(yield* wait(page.evaluate(() => document.documentElement.dataset.clockProbe))).toBe(
        "waiting"
      );
    })
  ));

test("accessibility checks retain violations inside cross-origin frames", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(
        page.route("https://*.accessibility.invalid/**", (route) =>
          route.fulfill({
            contentType: "text/html",
            body:
              new URL(route.request().url()).hostname === "child.accessibility.invalid"
                ? inaccessibleDocument
                : '<!doctype html><html lang="en"><head><title>Frame fixture</title></head><body><main><h1>Example</h1><iframe title="Example content" src="https://child.accessibility.invalid/"></iframe></main></body></html>',
          })
        )
      );
      yield* wait(page.goto("https://top.accessibility.invalid/"));
      yield* wait(expect(page.frameLocator("iframe").locator("#missing-name")).toBeVisible());
      const actual = yield* wait(analyzeAccessibility(page));
      const unnamed = actual.violations.filter(({ id }) => id === "button-name");
      expect(unnamed).toHaveLength(1);
      expect(accessibilityTargets(actual).join("\n")).toContain("missing-name");
    })
  ));

test("serves the checked-in security policy on SPA fallbacks", ({ request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const shell = yield* wait(request.get("/app/transactions"));
      expect(shell.status()).toBe(ok);
      expect(yield* wait(shell.text())).toContain('id="root"');
      expect(shell.headers()["cache-control"]).toBe("no-cache");
      expect(shell.headers()["content-security-policy"]).toContain(
        `connect-src ${topology.api} https://sandbox.wompi.co https://production.wompi.co https://api-sandbox.wompi.co/v1/webhook_events/daviplata_response/sandbox;`
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
      const api = topology.api;
      const browser = topology.app;
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
  request.get(`${topology.api}${path}`, { headers: { origin: topology.app } }).then((result) => {
    expect(result.status(), path).toBe(unauthorized);
    expect(result.headers()["cache-control"], path).toBe("no-store");
    expect(result.headers()["set-cookie"], path).toBeUndefined();
  });
test("Core refuses unauthenticated financial routes and untrusted support decisions", ({
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const api = topology.api;
      const headers = { origin: topology.app };
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
