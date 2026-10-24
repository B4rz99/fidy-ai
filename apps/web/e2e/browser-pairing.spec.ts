import { playwright } from "./playwright-runtime";
import { advanceAcceptancePoll, installAcceptanceClock } from "./acceptance-clock";
import type { APIRequestContext, BrowserContext, Page, Route } from "@playwright/test";
import { Array, type Cause, Clock, DateTime, Effect, Option } from "effect";
import { installUser } from "./http-fixtures";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";
import {
  boundSessionRequests,
  openBrowserLogin,
  openUpgradeThroughCore,
  reloadTransactionsThroughCore,
  visiblePairingCode,
} from "./real-core-fixture";

const { expect, test } = playwright;
const { api: apiOrigin, app: appOrigin, operator: operatorOrigin } = browserAcceptanceTopology();
const wait = <A>(promise: Promise<A>): Effect.Effect<A, Cause.UnknownError> =>
  Effect.tryPromise(() => promise);
const json = (value: object): string => JSON.stringify(value);
const runFixture = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);
const opaqueProofEncodedLength = 43;
const minimumPollIntervalMilliseconds = 5000;
const advancePastExpiryMilliseconds = 2_000;
const frozenExpiryClock = DateTime.makeUnsafe("2026-10-02T00:00:00Z");
const frozenPairingExpiry = DateTime.formatIso(DateTime.add(frozenExpiryClock, { seconds: 6 }));
const successStatus = 200;
const pendingStatus = 202;
const noContentStatus = 204;
const invalidStatus = 400;
const unauthorizedStatus = 401;
const notFoundStatus = 404;
const rateLimitedStatus = 429;
const pairingId = "24000000-0000-4000-8000-000000000240";
const privateVerifier = "v".repeat(opaqueProofEncodedLength);
const publicCode = "BCDF-GHJK";
const browserTime = (): number => performance.now();
const expiresAt = "2099-01-01T00:00:00.000Z";
const invalidPairingMessage = "Esta vinculación ya no es válida. Inicia de nuevo.";
test.describe.configure({ mode: "parallel" });
type PairingApiFixture = {
  startCount: number;
  redeemCount: number;
  activeRedeems: number;
  maximumActiveRedeems: number;
  logoutCount: number;
  readonly redeemTimes: Array<number>;
};
const installCanonicalProductRoutes = (page: Page): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const emptyList = json({ data: [], next: [] });
      yield* wait(
        page.route("**/categories", (route) =>
          route.fulfill({ contentType: "application/json", status: successStatus, body: emptyList })
        )
      );
      yield* wait(
        page.route(
          (url) => url.origin === apiOrigin && url.pathname === "/transactions",
          (route) =>
            route.fulfill({
              contentType: "application/json",
              status: successStatus,
              body: emptyList,
            })
        )
      );
    })
  );
const installReviewNavigationRoute = (page: Page): Promise<unknown> =>
  page.route("**/ingestion/review-workspace**", (route) =>
    route.fulfill({
      contentType: "application/json",
      status: successStatus,
      body: json({ data: { pendingCount: 0, total: 0, items: [] }, next: [] }),
    })
  );

const installStartAndLogoutRoutes = (page: Page, fixture: PairingApiFixture): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(
        page.route("**/web/pairings", (route) =>
          runFixture(
            Effect.gen(function* () {
              fixture.startCount += 1;
              yield* wait(
                route.fulfill({
                  contentType: "application/json",
                  status: successStatus,
                  body: json({
                    pairingId,
                    privateVerifier,
                    publicCode,
                    expiresAt,
                    pollingIntervalSeconds: 5,
                  }),
                })
              );
            })
          )
        )
      );
      yield* wait(installUser(page));
      yield* wait(installCanonicalProductRoutes(page));
      yield* wait(installReviewNavigationRoute(page));
      yield* wait(
        page.route("**/web/session/binding", (route) =>
          route.fulfill({ contentType: "application/json", body: json({ binding: pairingId }) })
        )
      );
      yield* wait(
        page.route("**/web/session/logout", (route) =>
          runFixture(
            Effect.gen(function* () {
              fixture.logoutCount += 1;
              yield* wait(
                route.fulfill({
                  status: 204,
                  headers: {
                    "set-cookie":
                      "__Host-fidy_session=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
                  },
                })
              );
            })
          )
        )
      );
    })
  );
const installPairingApiFixture = (page: Page): Promise<PairingApiFixture> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture: PairingApiFixture = {
        startCount: 0,
        redeemCount: 0,
        activeRedeems: 0,
        maximumActiveRedeems: 0,
        logoutCount: 0,
        redeemTimes: [],
      };
      yield* wait(installStartAndLogoutRoutes(page, fixture));
      yield* wait(
        page.route("**/web/pairings/redeem", (route) =>
          runFixture(
            Effect.gen(function* () {
              fixture.activeRedeems += 1;
              fixture.maximumActiveRedeems = Math.max(
                fixture.maximumActiveRedeems,
                fixture.activeRedeems
              );
              fixture.redeemCount += 1;
              fixture.redeemTimes.push(yield* wait(page.evaluate(browserTime)));
              expect(route.request().postDataJSON()).toEqual({ pairingId, privateVerifier });
              yield* Effect.sleep("100 millis");
              fixture.activeRedeems -= 1;
              const pending = fixture.redeemCount === 1;
              const responseHeaders: Record<string, string> = {
                "access-control-allow-origin": appOrigin,
                "access-control-allow-credentials": "true",
              };
              if (!pending) {
                responseHeaders["set-cookie"] =
                  "__Host-fidy_session=session-test; Secure; HttpOnly; SameSite=Strict; Path=/";
              }
              yield* wait(
                route.fulfill({
                  contentType: "application/json",
                  status: pending ? pendingStatus : successStatus,
                  headers: responseHeaders,
                  body: json(
                    pending
                      ? { status: "pending_approval", expiresAt, pollingIntervalSeconds: 5 }
                      : { status: "authenticated" }
                  ),
                })
              );
            })
          )
        )
      );
      return fixture;
    })
  );
const expectVerifierIsBrowserEphemeral = (page: Page): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(page.url()).not.toContain(pairingId);
      expect(page.url()).not.toContain(privateVerifier);
      expect(yield* wait(page.locator("html").textContent())).not.toContain(pairingId);
      expect(yield* wait(page.locator("html").textContent())).not.toContain(privateVerifier);
      expect(
        yield* wait(
          page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))
        )
      ).toEqual({ local: 0, session: 0 });
      expect(yield* wait(page.evaluate(() => caches.keys()))).toEqual([]);
      yield* wait(
        expect(page.getByRole("link", { name: "Abrir WhatsApp" })).not.toHaveAttribute(
          "href",
          new RegExp(`${pairingId}|${privateVerifier}`, "u")
        )
      );
    })
  );
test("keeps the verifier ephemeral, polls sequentially, retains the cookie, and logs out", ({
  context,
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(page.clock.install());
      const api = yield* wait(installPairingApiFixture(page));
      yield* wait(openBrowserLogin(page));
      yield* wait(expect(page.getByRole("button", { name: "WhatsApp" })).toBeVisible());
      expect(api.startCount).toBe(0);
      yield* wait(page.getByRole("button", { name: "WhatsApp" }).click());
      yield* wait(expect(page.getByText(publicCode, { exact: true })).toBeVisible());
      expect(api.startCount).toBe(1);
      yield* wait(expectVerifierIsBrowserEphemeral(page));
      const first = page.waitForResponse(
        (reply) => reply.url().endsWith("/web/pairings/redeem") && reply.status() === pendingStatus
      );
      yield* wait(page.clock.fastForward(minimumPollIntervalMilliseconds));
      yield* wait((yield* wait(first)).finished());
      expect(api.redeemCount).toBe(1);
      yield* wait(page.clock.fastForward(minimumPollIntervalMilliseconds));
      yield* wait(expect(page).toHaveURL(/\/app\/transactions$/u, { timeout: 15000 }));
      yield* wait(
        expect(page.getByRole("heading", { name: "Transacciones", exact: true })).toBeVisible()
      );
      expect(api.redeemCount).toBe(2);
      expect(api.maximumActiveRedeems).toBe(1);
      const [firstPollAt = 0, secondPollAt = 0] = api.redeemTimes;
      expect(secondPollAt - firstPollAt).toBeGreaterThanOrEqual(minimumPollIntervalMilliseconds);
      expect(yield* wait(context.cookies())).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "__Host-fidy_session",
            httpOnly: true,
            secure: true,
            sameSite: "Strict",
          }),
        ])
      );
      yield* wait(page.reload());
      yield* wait(
        expect(page.getByRole("heading", { name: "Transacciones", exact: true })).toBeVisible()
      );
      expect(api.startCount).toBe(1);
      expect(yield* wait(context.cookies())).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "__Host-fidy_session" })])
      );
      yield* wait(page.getByRole("button", { name: "Cerrar sesión" }).click());
      yield* wait(expect(page.getByRole("button", { name: "Continuar con Google" })).toBeVisible());
      expect(api.logoutCount).toBe(1);
      expect(
        (yield* wait(context.cookies())).some(({ name }) => name === "__Host-fidy_session")
      ).toBe(false);
    })
  ));
const emailLoginCode = "ABCD-EFGH-JKLM-NPQR-STUV-WXYZ";
const emailLoginAddress = "usuario@example.com";
const installEmailApprovalRoutes = (
  page: Page
): Promise<{
  isApproved: () => boolean;
  attempts: () => number;
}> =>
  Effect.runPromise(
    Effect.gen(function* () {
      let completed = false;
      let attempts = 0;
      yield* wait(
        page.route("**/web/email/authentication/start", (route) => {
          expect(route.request().postDataJSON()).toEqual({
            pairingId,
            privateVerifier,
            email: emailLoginAddress,
          });
          return route.fulfill({
            contentType: "application/json",
            status: pendingStatus,
            body: json({ status: "pending", retryAfterSeconds: 60 }),
          });
        })
      );
      yield* wait(
        page.route("**/web/email/authentication/complete", (route) => {
          attempts += 1;
          expect(route.request().postDataJSON()).toEqual({
            pairingId,
            privateVerifier,
            combinedCode: emailLoginCode,
          });
          completed = attempts === 2;
          return route.fulfill(
            completed
              ? {
                  status: successStatus,
                  contentType: "application/json",
                  body: json({ status: "approved" }),
                }
              : {
                  status: invalidStatus,
                  contentType: "application/json",
                  body: json({
                    error: {
                      code: "email_authentication_invalid",
                      message: "El código no es válido.",
                    },
                  }),
                }
          );
        })
      );
      return { isApproved: () => completed, attempts: () => attempts };
    })
  );
const installEmailLoginRoutes = (page: Page): Promise<() => number> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(
        installStartAndLogoutRoutes(page, {
          startCount: 0,
          redeemCount: 0,
          activeRedeems: 0,
          maximumActiveRedeems: 0,
          logoutCount: 0,
          redeemTimes: [],
        })
      );
      const approval = yield* wait(installEmailApprovalRoutes(page));
      yield* wait(
        page.route("**/web/pairings/redeem", (route) =>
          route.fulfill({
            contentType: "application/json",
            status: approval.isApproved() ? successStatus : pendingStatus,
            headers: approval.isApproved()
              ? {
                  "set-cookie":
                    "__Host-fidy_session=session-test; Secure; HttpOnly; SameSite=Strict; Path=/",
                }
              : {},
            body: json(
              approval.isApproved()
                ? { status: "authenticated" }
                : { status: "pending_approval", expiresAt, pollingIntervalSeconds: 5 }
            ),
          })
        )
      );
      return approval.attempts;
    })
  );
test("approves email login with the private browser verifier without exposing mailbox proof", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(page.clock.install());
      const attempts = yield* wait(installEmailLoginRoutes(page));
      yield* wait(openBrowserLogin(page));
      yield* wait(page.getByRole("button", { name: "Correo verificado", exact: true }).click());
      yield* wait(expect(page.getByRole("heading", { name: "Entra con tu correo" })).toBeVisible());
      yield* wait(page.getByLabel("Correo verificado").fill(emailLoginAddress));
      yield* wait(page.getByRole("button", { name: "Enviar código" }).click());
      yield* wait(expect(page.getByLabel("Código del correo")).toBeVisible());
      yield* wait(page.getByLabel("Código del correo").fill(emailLoginCode));
      yield* wait(page.getByRole("button", { name: "Confirmar y entrar" }).click());
      yield* wait(
        expect(
          page.getByText("No pudimos validar ese código. Revísalo o solicita uno nuevo.")
        ).toBeVisible()
      );
      yield* wait(page.getByLabel("Código del correo").fill(emailLoginCode));
      const approved = page.waitForResponse(
        (reply) =>
          reply.url().endsWith("/web/email/authentication/complete") &&
          reply.status() === successStatus
      );
      yield* wait(page.getByRole("button", { name: "Confirmar y entrar" }).click());
      yield* wait((yield* wait(approved)).finished());
      yield* wait(page.clock.fastForward(minimumPollIntervalMilliseconds));
      yield* wait(expect(page).toHaveURL(/\/app\/transactions$/u, { timeout: 15000 }));
      expect(attempts()).toBe(2);
      expect(page.url()).not.toContain(emailLoginCode);
      expect(
        yield* wait(
          page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))
        )
      ).toEqual({ local: 0, session: 0 });
    })
  ));
type BrowserCookie = Awaited<ReturnType<BrowserContext["cookies"]>>[number];
const verifyRevokedBrowser = (
  page: Page,
  context: BrowserContext,
  session: Option.Option<BrowserCookie>
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (Option.isNone(session)) throw new Error("Expected a redeemed WebSession cookie");
      yield* wait(context.addCookies([session.value]));
      yield* wait(page.goto("/app/transactions"));
      yield* wait(expect(page.getByRole("alert")).toContainText("Acceso no autorizado"));
      expect(yield* wait(page.locator("body").textContent())).not.toContain("OTHER-USER-PRIVATE");
    })
  );
const editAndCheckDashboard = (page: Page): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(page.goto("/app/dashboard"));
      yield* wait(expect(page.getByRole("button", { name: "Personalizar" })).toBeVisible());
      yield* wait(page.getByRole("button", { name: "Personalizar" }).click());
      yield* wait(
        page
          .getByRole("region", { name: "Diseño responsivo del tablero" })
          .getByRole("button", { name: /^Renombrar /u })
          .first()
          .click()
      );
      yield* wait(
        page.getByRole("textbox", { name: "Nuevo nombre del Widget" }).fill("Gastos visibles")
      );
      const saved = page.waitForResponse(
        (response) =>
          response.url().endsWith("/dashboard/edits") && response.status() === successStatus
      );
      yield* wait(page.getByRole("button", { name: "Guardar nombre del Widget" }).click());
      yield* wait(saved);
      yield* wait(expect(page.getByText("Gastos visibles").first()).toBeVisible());
      yield* wait(page.reload());
      yield* wait(expect(page.getByText("Gastos visibles").first()).toBeVisible());
    })
  );
const hasSessionCookie = (context: BrowserContext): Promise<boolean> =>
  context
    .cookies()
    .then((cookies) => cookies.some((cookie) => cookie.name === "__Host-fidy_session"));

const finishRealPairing = ({
  page,
  context,
  request,
  session,
}: {
  page: Page;
  context: BrowserContext;
  request: APIRequestContext;
  session: Option.Option<BrowserCookie>;
}): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(page.getByRole("button", { name: "+ Registrar", exact: true }).click());
      yield* wait(page.getByLabel("Monto · COP").fill("12500"));
      yield* wait(page.getByLabel("Contraparte (opcional)").fill("La Cocina"));
      yield* wait(page.getByRole("button", { name: "Registrar", exact: true }).click());
      yield* wait(expect(page.locator("[data-sonner-toast]")).toContainText("La Cocina"));
      yield* wait(editAndCheckDashboard(page));
      yield* wait(openUpgradeThroughCore(page));
      yield* wait(expect(page.getByRole("button", { name: "Elegir mensual" })).toBeVisible());
      yield* wait(page.goto("/app/transactions"));
      const loggedOut = page.waitForResponse("**/web/session/logout");
      yield* wait(page.getByRole("button", { name: "Cerrar sesión" }).click());
      expect((yield* wait(loggedOut)).status()).toBe(noContentStatus);
      yield* wait(expect.poll(() => hasSessionCookie(context)).toBe(false));
      yield* wait(expect(page).toHaveURL(/\/login$/u));
      yield* wait(expect(page.getByRole("button", { name: "Continuar con Google" })).toBeVisible());
      const revoked = yield* wait(
        request.get(`${apiOrigin}/user`, {
          headers: {
            origin: appOrigin,
            cookie: `${Option.getOrUndefined(session)?.name}=${Option.getOrUndefined(session)?.value}`,
          },
        })
      );
      expect(revoked.status()).toBe(unauthorizedStatus);
      yield* wait(verifyRevokedBrowser(page, context, session));
    })
  );

test("redeems a real pairing approved out of band and obtains a real WebSession", ({
  context,
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(installAcceptanceClock(page));
      yield* wait(openBrowserLogin(page));
      yield* wait(page.getByRole("button", { name: "WhatsApp" }).click());
      const code = yield* wait(visiblePairingCode(page));
      const approval = yield* wait(
        request.post(`${operatorOrigin}/approve?code=${code}&pairing=true`)
      );
      expect(approval.status()).toBe(noContentStatus);
      yield* wait(advanceAcceptancePoll({ page, milliseconds: minimumPollIntervalMilliseconds }));
      yield* wait(expect(page).toHaveURL(/\/app\/transactions$/u, { timeout: 15000 }));
      yield* wait(
        expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeVisible()
      );
      const session = Array.findFirst(
        yield* wait(context.cookies()),
        (cookie) => cookie.name === "__Host-fidy_session"
      );
      expect(Option.getOrUndefined(session)?.httpOnly).toBe(true);
      expect(Option.getOrUndefined(session)?.secure).toBe(true);
      const current = yield* wait(
        boundSessionRequests(page.request).get(`${apiOrigin}/user`, {
          headers: { origin: appOrigin },
        })
      );
      expect(current.status()).toBe(successStatus);
      expect(yield* wait(current.json())).toMatchObject({
        data: { id: "24000000-0000-4000-8000-000000000321" },
      });
      const otherTransaction = yield* wait(
        boundSessionRequests(page.request).get(
          `${apiOrigin}/transactions/24000000-0000-4000-8000-000000000262`,
          {
            headers: {
              origin: appOrigin,
              cookie: `${Option.getOrUndefined(session)?.name}=${Option.getOrUndefined(session)?.value}`,
            },
          }
        )
      );
      expect(otherTransaction.status()).toBe(notFoundStatus);
      expect(yield* wait(otherTransaction.text())).not.toContain("OTHER-USER-PRIVATE");
      yield* wait(finishRealPairing({ page, context, request, session }));
    })
  ));
test("a SupportRecoveryCase approves the browser-private pairing through the real Core", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(installAcceptanceClock(page));
      const pending = page.waitForResponse(
        (reply) => reply.url().endsWith("/web/pairings/redeem") && reply.status() === pendingStatus
      );
      yield* wait(openBrowserLogin(page));
      yield* wait(page.getByRole("button", { name: "WhatsApp" }).click());
      const code = yield* wait(visiblePairingCode(page));
      yield* wait(advanceAcceptancePoll({ page, milliseconds: minimumPollIntervalMilliseconds }));
      yield* wait(pending);
      const signed = yield* wait((yield* wait(request.get(`${operatorOrigin}/assertion`))).text());
      const decision = (): ReturnType<typeof request.post> =>
        request.post(`${apiOrigin}/internal/support-recovery`, {
          headers: { "cf-access-jwt-assertion": signed },
          data: { pairingCode: code, backupRecoveryCode: "ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2" },
        });
      expect((yield* wait(decision())).status()).toBe(successStatus);
      expect((yield* wait(decision())).status()).toBe(invalidStatus);
      yield* wait(advanceAcceptancePoll({ page, milliseconds: minimumPollIntervalMilliseconds }));
      yield* wait(expect(page).toHaveURL(/\/app\/transactions$/u, { timeout: 15000 }));
      const recovered = yield* wait(
        boundSessionRequests(page.request).get(`${apiOrigin}/user`, {
          headers: { origin: appOrigin },
        })
      );
      expect(yield* wait(recovered.json())).toMatchObject({
        data: { id: "24000000-0000-4000-8000-000000000311" },
      });
      yield* wait(
        expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeVisible()
      );
      yield* wait(page.getByRole("button", { name: "+ Registrar", exact: true }).click());
      yield* wait(page.getByLabel("Monto · COP").fill("12345"));
      yield* wait(page.getByLabel("Contraparte (opcional)").fill("Recuperación Fidy"));
      yield* wait(page.getByRole("button", { name: "Registrar", exact: true }).click());
      yield* wait(expect(page.locator("[data-sonner-toast]")).toContainText("Recuperación Fidy"));
      yield* wait(reloadTransactionsThroughCore(page));
      yield* wait(expect(page.getByText("Recuperación Fidy").first()).toBeVisible());
      expect(page.url()).not.toContain("ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2");
      expect(yield* wait(page.evaluate(() => localStorage.length + sessionStorage.length))).toBe(0);
    })
  ));
const slowdownDelayMilliseconds = 10000;
const pendingRequestAdvanceMilliseconds = 6000;
const installSlowdownRoutes = (page: Page): Promise<{ events: string[]; pendingRoutes: Route[] }> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const events: string[] = [];
      const pendingRoutes: Route[] = [];
      yield* wait(
        page.route("**/web/pairings", (route) => {
          events.push("start");
          return route.fulfill({
            contentType: "application/json",
            status: successStatus,
            body: json({
              pairingId,
              privateVerifier,
              publicCode,
              expiresAt,
              pollingIntervalSeconds: 5,
            }),
          });
        })
      );
      yield* wait(
        page.route("**/web/pairings/redeem", (route) => {
          expect(route.request().postDataJSON()).toEqual({ pairingId, privateVerifier });
          pendingRoutes.push(route);
          events.push(`redeem-${pendingRoutes.length}`);
        })
      );
      return { events, pendingRoutes };
    })
  );

test("honors server slowdown before showing the generic terminal refusal", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(page.clock.install());
      const { events, pendingRoutes } = yield* wait(installSlowdownRoutes(page));
      yield* wait(openBrowserLogin(page));
      yield* wait(page.getByRole("button", { name: "WhatsApp" }).click());
      yield* wait(expect(page.getByText(publicCode, { exact: true })).toBeVisible());
      yield* wait(page.clock.fastForward(minimumPollIntervalMilliseconds));
      yield* wait(expect.poll(() => pendingRoutes.length).toBe(1));
      yield* wait(
        page.clock.pauseAt((yield* Clock.currentTimeMillis) + minimumPollIntervalMilliseconds)
      );
      yield* wait(page.clock.runFor(pendingRequestAdvanceMilliseconds));
      expect(events).toEqual(["start", "redeem-1"]);
      yield* wait(expect(page.getByText(invalidPairingMessage)).not.toBeVisible());
      const first = Option.getOrThrow(Option.fromUndefinedOr(pendingRoutes[0]));
      const slowed = page.waitForResponse(
        (reply) =>
          reply.url().endsWith("/web/pairings/redeem") && reply.status() === rateLimitedStatus
      );
      events.push("slowdown");
      yield* wait(
        first.fulfill({
          contentType: "application/json",
          status: rateLimitedStatus,
          headers: { "retry-after": "10" },
          body: json({ error: { code: "rate_limited", retryAfterSeconds: 10 } }),
        })
      );
      yield* wait((yield* wait(slowed)).finished());
      yield* wait(page.clock.runFor(slowdownDelayMilliseconds - 1));
      expect(events).toEqual(["start", "redeem-1", "slowdown"]);
      yield* wait(expect(page.getByText(invalidPairingMessage)).not.toBeVisible());
      yield* wait(page.clock.runFor(1));
      yield* wait(expect.poll(() => pendingRoutes.length).toBe(2));
      expect(events).toEqual(["start", "redeem-1", "slowdown", "redeem-2"]);
      yield* wait(expect(page.getByText(invalidPairingMessage)).not.toBeVisible());
      const second = Option.getOrThrow(Option.fromUndefinedOr(pendingRoutes[1]));
      events.push("invalid");
      yield* wait(
        second.fulfill({
          contentType: "application/json",
          status: invalidStatus,
          body: json({ error: { code: "pairing_invalid", message: invalidPairingMessage } }),
        })
      );
      yield* wait(
        expect(page.getByRole("heading", { name: "Acceso no autorizado" })).toBeVisible({
          timeout: 20000,
        })
      );
      yield* wait(page.clock.runFor(slowdownDelayMilliseconds));
      expect(events).toEqual(["start", "redeem-1", "slowdown", "redeem-2", "invalid"]);
      expect(pendingRoutes).toHaveLength(2);
    })
  ));
const installExpiringPairingRoutes = (
  page: Page,
  counts: { start: number; redeem: number }
): Promise<void> =>
  page
    .route("**/web/pairings", (route: Route) => {
      counts.start += 1;
      return route.fulfill({
        contentType: "application/json",
        status: successStatus,
        body: json({
          pairingId,
          privateVerifier,
          publicCode,
          expiresAt: frozenPairingExpiry,
          pollingIntervalSeconds: 5,
        }),
      });
    })
    .then(() =>
      page.route("**/web/pairings/redeem", () => {
        counts.redeem += 1;
      })
    )
    .then(() => Promise.resolve());

test("stops at pairing expiry after a timed-out poll without creating a replacement", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const counts = { start: 0, redeem: 0 };
      yield* wait(page.clock.install({ time: "2026-10-01T00:00:00Z" }));
      yield* wait(page.clock.pauseAt(DateTime.toEpochMillis(frozenExpiryClock)));
      yield* wait(installExpiringPairingRoutes(page, counts));
      yield* wait(openBrowserLogin(page));
      yield* wait(page.getByRole("button", { name: "WhatsApp" }).click());
      yield* wait(expect(page.getByText(publicCode, { exact: true })).toBeVisible());
      yield* wait(page.clock.fastForward(minimumPollIntervalMilliseconds));
      yield* wait(expect.poll(() => counts.redeem).toBe(1));
      yield* wait(expect(page.getByText(invalidPairingMessage)).not.toBeVisible());
      yield* wait(page.clock.fastForward(advancePastExpiryMilliseconds));
      yield* wait(expect(page.getByRole("heading", { name: "El código venció" })).toBeVisible());
      expect(counts.start).toBe(1);
      expect(counts.redeem).toBe(1);
    })
  ));

const installMethodSwitchRoutes = (
  page: Page
): Promise<{ starts: () => number; emailRequests: () => number }> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const emailVerifier = "e".repeat(opaqueProofEncodedLength);
      let starts = 0;
      let emailRequests = 0;
      yield* wait(
        page.route("**/web/pairings", (route) => {
          starts += 1;
          return route.fulfill({
            contentType: "application/json",
            body: json({
              pairingId,
              privateVerifier: starts === 1 ? privateVerifier : emailVerifier,
              publicCode,
              expiresAt,
              pollingIntervalSeconds: 5,
            }),
          });
        })
      );
      yield* wait(
        page.route("**/web/email/authentication/start", (route) => {
          emailRequests += 1;
          expect(route.request().postDataJSON()).toEqual({
            pairingId,
            privateVerifier: emailVerifier,
            email: emailLoginAddress,
          });
          return route.fulfill({
            status: pendingStatus,
            contentType: "application/json",
            body: json({ status: "pending", retryAfterSeconds: 60 }),
          });
        })
      );
      return { starts: () => starts, emailRequests: () => emailRequests };
    })
  );

test("discards an in-flight verifier when switching methods and starts email only on submit", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(page.clock.install());
      const { events, pendingRoutes } = yield* wait(installSlowdownRoutes(page));
      const counts = yield* wait(installMethodSwitchRoutes(page));
      yield* wait(openBrowserLogin(page));
      yield* wait(page.getByRole("button", { name: "WhatsApp", exact: true }).click());
      yield* wait(expect(page.getByText(publicCode, { exact: true })).toBeVisible());
      yield* wait(page.clock.fastForward(minimumPollIntervalMilliseconds));
      yield* wait(expect.poll(() => pendingRoutes.length).toBe(1));
      yield* wait(
        page.getByRole("button", { name: "Continuar con correo verificado", exact: true }).click()
      );
      yield* wait(expect(page.getByRole("heading", { name: "Entra con tu correo" })).toBeVisible());
      yield* wait(
        Option.getOrThrow(Option.fromUndefinedOr(pendingRoutes[0])).fulfill({
          status: invalidStatus,
          contentType: "application/json",
          body: json({ error: { code: "pairing_invalid", message: invalidPairingMessage } }),
        })
      );
      yield* wait(page.clock.runFor(slowdownDelayMilliseconds));
      expect(counts.starts()).toBe(1);
      expect(events).toEqual(["redeem-1"]);
      yield* wait(expect(page.getByRole("heading", { name: "Entra con tu correo" })).toBeVisible());
      yield* wait(page.getByLabel("Correo verificado").fill(emailLoginAddress));
      yield* wait(page.getByRole("button", { name: "Enviar código", exact: true }).click());
      yield* wait(expect(page.getByRole("heading", { name: "Revisa tu correo" })).toBeVisible());
      expect(counts.starts()).toBe(2);
      expect(counts.emailRequests()).toBe(1);
      yield* wait(page.getByRole("button", { name: "Opciones de inicio de sesión" }).click());
      yield* wait(page.clock.runFor(slowdownDelayMilliseconds));
      expect(pendingRoutes).toHaveLength(1);
      yield* wait(expect(page.getByRole("heading", { name: "Entra a tu Fidy" })).toBeVisible());
      yield* wait(page.getByRole("button", { name: "Correo verificado", exact: true }).click());
      yield* wait(expect(page.getByLabel("Correo verificado")).toHaveValue(""));
      expect(counts.starts()).toBe(2);
    })
  ));

const emailCooldownSeconds = 60;
const secondMilliseconds = 1000;
const installEmailCooldownRoutes = (page: Page): Promise<() => number> =>
  Effect.runPromise(
    Effect.gen(function* () {
      let sends = 0;
      yield* wait(
        page.route("**/web/email/authentication/start", (route) => {
          sends += 1;
          expect(route.request().postDataJSON()).toEqual({
            pairingId,
            privateVerifier,
            email: emailLoginAddress,
          });
          return route.fulfill({
            status: pendingStatus,
            contentType: "application/json",
            body: json({
              status: "pending",
              retryAfterSeconds: emailCooldownSeconds,
            }),
          });
        })
      );
      // Keep approval pending while only advancing the public server's cooldown.
      yield* wait(
        page.route("**/web/pairings/redeem", (route) =>
          route.fulfill({
            status: pendingStatus,
            contentType: "application/json",
            body: json({ status: "pending_approval", expiresAt, pollingIntervalSeconds: 5 }),
          })
        )
      );
      return () => sends;
    })
  );

test("honors each server email resend cooldown without creating another pairing", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(page.clock.install({ time: "2026-10-01T00:00:00Z" }));
      yield* wait(page.clock.pauseAt(DateTime.toEpochMillis(frozenExpiryClock)));
      const fixture = yield* wait(installPairingApiFixture(page));
      const sends = yield* wait(installEmailCooldownRoutes(page));
      yield* wait(openBrowserLogin(page));
      yield* wait(page.getByRole("button", { name: "Correo verificado", exact: true }).click());
      expect(fixture.startCount).toBe(0);
      yield* wait(page.getByLabel("Correo verificado").fill(emailLoginAddress));
      yield* wait(page.getByRole("button", { name: "Enviar código", exact: true }).click());
      yield* wait(expect(page.getByRole("heading", { name: "Revisa tu correo" })).toBeVisible());
      yield* wait(
        expect(page.getByRole("button", { name: "Reenviar código", exact: true })).toHaveCount(0)
      );
      yield* wait(page.clock.runFor((emailCooldownSeconds - 1) * secondMilliseconds));
      yield* wait(
        expect(page.getByRole("button", { name: "Reenviar código", exact: true })).toHaveCount(0)
      );
      expect(sends()).toBe(1);
      yield* wait(page.clock.runFor(secondMilliseconds));
      yield* wait(page.getByRole("button", { name: "Reenviar código", exact: true }).click());
      yield* wait(expect.poll(sends).toBe(2));
      yield* wait(
        expect(page.getByText("Podrás reenviarlo en 01:00", { exact: true })).toBeVisible()
      );
      yield* wait(
        expect(page.getByRole("button", { name: "Reenviar código", exact: true })).toHaveCount(0)
      );
      yield* wait(page.clock.runFor((emailCooldownSeconds - 1) * secondMilliseconds));
      yield* wait(
        expect(page.getByRole("button", { name: "Reenviar código", exact: true })).toHaveCount(0)
      );
      expect(sends()).toBe(2);
      yield* wait(page.clock.runFor(secondMilliseconds));
      yield* wait(
        expect(page.getByRole("button", { name: "Reenviar código", exact: true })).toBeEnabled()
      );
      expect(fixture.startCount).toBe(1);
    })
  ));
