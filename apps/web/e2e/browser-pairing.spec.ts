import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { type Cause, Clock, DateTime, Effect } from "effect";

const opaqueProofEncodedLength = 43;
const minimumPollIntervalMilliseconds = 5_000;
const successStatus = 200;
const pendingStatus = 202;
const invalidStatus = 400;
const rateLimitedStatus = 429;
const pairingId = "24000000-0000-4000-8000-000000000240";
const privateVerifier = "v".repeat(opaqueProofEncodedLength);
const publicCode = "BCDF-GHJK";
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

const installCanonicalProductRoutes = (page: Page): Promise<void> => {
  const emptyList = JSON.stringify({ data: [], next: [] });
  return page
    .route("**/categories", (route) =>
      route.fulfill({ contentType: "application/json", status: successStatus, body: emptyList })
    )
    .then(() =>
      page.route(/^https:\/\/127\.0\.0\.1:4174\/transactions(?:\?.*)?$/u, (route) =>
        route.fulfill({ contentType: "application/json", status: successStatus, body: emptyList })
      )
    )
    .then(() => {});
};

const installStartAndLogoutRoutes = (page: Page, fixture: PairingApiFixture): Promise<void> =>
  page
    .route("**/web/pairings", (route) => {
      fixture.startCount += 1;
      return route.fulfill({
        contentType: "application/json",
        status: successStatus,
        body: JSON.stringify({
          pairingId,
          privateVerifier,
          publicCode,
          expiresAt,
          pollingIntervalSeconds: 5,
        }),
      });
    })
    .then(() =>
      page.route("**/user", (route) =>
        route.fulfill({
          contentType: "application/json",
          status: successStatus,
          body: JSON.stringify({
            data: {
              id: "24000000-0000-4000-8000-000000000241",
              serviceMarket: "CO",
              locale: "es-CO",
              timeZone: "America/Bogota",
              trialPeriod: {
                startedAt: "2026-08-01T00:00:00Z",
                endsAt: "2026-08-08T00:00:00Z",
              },
              createdAt: "2026-08-01T00:00:00Z",
            },
            next: [],
          }),
        })
      )
    )
    .then(() => installCanonicalProductRoutes(page))
    .then(() =>
      page.route("**/web/session/logout", (route) => {
        fixture.logoutCount += 1;
        return route.fulfill({
          status: 204,
          headers: {
            "set-cookie":
              "__Host-fidy_session=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
          },
        });
      })
    )
    .then(() => {});

const installPairingApiFixture = (page: Page): Promise<PairingApiFixture> => {
  const fixture: PairingApiFixture = {
    startCount: 0,
    redeemCount: 0,
    activeRedeems: 0,
    maximumActiveRedeems: 0,
    logoutCount: 0,
    redeemTimes: [],
  };
  return installStartAndLogoutRoutes(page, fixture)
    .then(() =>
      page.route("**/web/pairings/redeem", (route) => {
        fixture.activeRedeems += 1;
        fixture.maximumActiveRedeems = Math.max(
          fixture.maximumActiveRedeems,
          fixture.activeRedeems
        );
        fixture.redeemCount += 1;
        return Effect.runPromise(Clock.currentTimeMillis)
          .then((time) => {
            fixture.redeemTimes.push(time);
            expect(route.request().postDataJSON()).toEqual({ pairingId, privateVerifier });
            return Effect.runPromise(Effect.sleep("100 millis"));
          })
          .then(() => {
            fixture.activeRedeems -= 1;
            const pending = fixture.redeemCount === 1;
            const responseHeaders: Record<string, string> = {
              "access-control-allow-origin": "https://127.0.0.1:4173",
              "access-control-allow-credentials": "true",
            };
            if (!pending) {
              responseHeaders["set-cookie"] =
                "__Host-fidy_session=session-test; Secure; HttpOnly; SameSite=Strict; Path=/";
            }
            return route.fulfill({
              contentType: "application/json",
              status: pending ? pendingStatus : successStatus,
              headers: responseHeaders,
              body: JSON.stringify(
                pending
                  ? { status: "pending_approval", expiresAt, pollingIntervalSeconds: 5 }
                  : { status: "authenticated" }
              ),
            });
          });
      })
    )
    .then(() => fixture);
};

const expectVerifierIsBrowserEphemeral = (page: Page): Promise<void> => {
  expect(page.url()).not.toContain(pairingId);
  expect(page.url()).not.toContain(privateVerifier);
  return Promise.all([
    page.locator("html").textContent(),
    page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
    page.evaluate(() => caches.keys()),
  ]).then(([text, storage, cacheKeys]) => {
    expect(text).not.toContain(pairingId);
    expect(text).not.toContain(privateVerifier);
    expect(storage).toEqual({ local: 0, session: 0 });
    expect(cacheKeys).toEqual([]);
    return expect(page.getByRole("link", { name: "Abrir WhatsApp" })).not.toHaveAttribute(
      "href",
      new RegExp(`${pairingId}|${privateVerifier}`, "u")
    );
  });
};

const waitFor = <A>(run: () => Promise<A>): Effect.Effect<A, Cause.UnknownError> =>
  Effect.tryPromise(run);

const expiryInSixSeconds = (): Promise<string> =>
  Effect.runPromise(
    DateTime.now.pipe(
      Effect.map((now) => DateTime.add(now, { seconds: 6 })),
      Effect.map(DateTime.formatIso)
    )
  );

test("keeps the verifier ephemeral, polls sequentially, retains the cookie, and logs out", ({
  context,
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const api = yield* waitFor(() => installPairingApiFixture(page));
      yield* waitFor(() => page.goto("/auth/pair"));
      yield* waitFor(() =>
        expect(page.getByRole("button", { name: "Iniciar sesión en el navegador" })).toBeVisible()
      );
      expect(api.startCount).toBe(0);

      yield* waitFor(() =>
        page.getByRole("button", { name: "Iniciar sesión en el navegador" }).click()
      );
      yield* waitFor(() => expect(page.getByText(publicCode, { exact: true })).toBeVisible());
      expect(api.startCount).toBe(1);
      yield* waitFor(() => expectVerifierIsBrowserEphemeral(page));
      yield* waitFor(() => expect(page).toHaveURL(/\/app\/transactions$/u, { timeout: 15_000 }));
      yield* waitFor(() =>
        expect(page.getByRole("heading", { name: "Transacciones" })).toBeVisible()
      );

      expect(api.redeemCount).toBe(2);
      expect(api.maximumActiveRedeems).toBe(1);
      const [firstPollAt = 0, secondPollAt = 0] = api.redeemTimes;
      expect(secondPollAt - firstPollAt).toBeGreaterThanOrEqual(minimumPollIntervalMilliseconds);
      expect(yield* waitFor(() => context.cookies())).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "__Host-fidy_session",
            httpOnly: true,
            secure: true,
            sameSite: "Strict",
          }),
        ])
      );

      yield* waitFor(() => page.reload());
      yield* waitFor(() => expect(page.getByText("America/Bogota", { exact: true })).toBeVisible());
      expect(api.startCount).toBe(1);
      expect(yield* waitFor(() => context.cookies())).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "__Host-fidy_session" })])
      );

      yield* waitFor(() => page.getByRole("button", { name: "Cerrar sesión" }).click());
      yield* waitFor(() =>
        expect(page.getByRole("button", { name: "Iniciar sesión en el navegador" })).toBeVisible()
      );
      expect(api.logoutCount).toBe(1);
      expect(
        (yield* waitFor(() => context.cookies())).some(({ name }) => name === "__Host-fidy_session")
      ).toBe(false);
    })
  ));

const installSlowdownRoutes = (page: Page, fixture: { count: number }): Promise<void> =>
  page
    .route("**/web/pairings", (route) =>
      route.fulfill({
        contentType: "application/json",
        status: successStatus,
        body: JSON.stringify({
          pairingId,
          privateVerifier,
          publicCode,
          expiresAt,
          pollingIntervalSeconds: 5,
        }),
      })
    )
    .then(() =>
      page.route("**/web/pairings/redeem", (route) => {
        fixture.count += 1;
        return route.fulfill(
          fixture.count === 1
            ? {
                contentType: "application/json",
                status: rateLimitedStatus,
                headers: { "retry-after": "10" },
                body: JSON.stringify({ error: { code: "rate_limited", retryAfterSeconds: 10 } }),
              }
            : {
                contentType: "application/json",
                status: invalidStatus,
                body: JSON.stringify({
                  error: { code: "pairing_invalid", message: invalidPairingMessage },
                }),
              }
        );
      })
    )
    .then(() => {});

const installExpiringRoutes = (
  page: Page,
  fixture: { startCount: number; redeemCount: number }
): Promise<void> =>
  page
    .route("**/web/pairings", (route) => {
      fixture.startCount += 1;
      return expiryInSixSeconds().then((shortExpiry) =>
        route.fulfill({
          contentType: "application/json",
          status: successStatus,
          body: JSON.stringify({
            pairingId,
            privateVerifier,
            publicCode,
            expiresAt: shortExpiry,
            pollingIntervalSeconds: 5,
          }),
        })
      );
    })
    .then(() =>
      page.route("**/web/pairings/redeem", () => {
        fixture.redeemCount += 1;
      })
    )
    .then(() => {});

test("honors server slowdown before showing the generic terminal refusal", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = { count: 0 };
      yield* waitFor(() => installSlowdownRoutes(page, fixture));

      yield* waitFor(() => page.goto("/auth/pair"));
      yield* waitFor(() =>
        page.getByRole("button", { name: "Iniciar sesión en el navegador" }).click()
      );
      yield* waitFor(() =>
        expect(page.getByText(invalidPairingMessage)).toBeVisible({ timeout: 20_000 })
      );
      expect(fixture.count).toBe(2);
    })
  ));

test("stops at pairing expiry after a timed-out poll without creating a replacement", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = { startCount: 0, redeemCount: 0 };
      yield* waitFor(() => installExpiringRoutes(page, fixture));

      yield* waitFor(() => page.goto("/auth/pair"));
      yield* waitFor(() =>
        page.getByRole("button", { name: "Iniciar sesión en el navegador" }).click()
      );
      yield* waitFor(() =>
        expect(page.getByText(invalidPairingMessage)).toBeVisible({ timeout: 10_000 })
      );
      expect(fixture.startCount).toBe(1);
      expect(fixture.redeemCount).toBe(1);
    })
  ));
