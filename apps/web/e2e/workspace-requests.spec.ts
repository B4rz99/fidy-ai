import { prepareAssessmentFixture } from "./assessment-fixture";
import { type Cause, Clock, Deferred, Effect } from "effect";
import type { Page, Response, Route } from "@playwright/test";
import { apiOrigin } from "./http-fixtures";
import { playwright } from "./playwright-runtime";
import { signInNavigationPerformanceThroughCore } from "./real-core-fixture";

const { test, expect } = playwright;
test.beforeAll(prepareAssessmentFixture);
const successfulStatus = 200;
const isMaterialRead = (response: Response): boolean =>
  response.status() === successfulStatus && new URL(response.url()).pathname.endsWith("/material");
const isWorkspaceRead = (response: Response): boolean =>
  response.status() === successfulStatus &&
  response.request().method() === "GET" &&
  new URL(response.url()).pathname === "/ingestion/review-workspace";
const observeSuccessfulReads = (page: Page): string[] => {
  const reads: string[] = [];
  page.on("response", (response) => {
    const read = response.request();
    if (
      read.url().startsWith(apiOrigin) &&
      read.method() === "GET" &&
      response.status() === successfulStatus
    ) {
      reads.push(new URL(read.url()).pathname);
    }
  });
  return reads;
};
const dispatchFocus = (page: Page): Promise<boolean> =>
  page.evaluate(() => window.dispatchEvent(new Event("focus")));
const dispatchVisibility = (page: Page): Promise<boolean> =>
  page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
const expectEntryRecheck = (
  reads: ReadonlyArray<string>,
  contexts: ReadonlyArray<string>
): void => {
  // A private entry is followed by a binding-only proof before navigation reuses the actor.
  expect(reads.filter((path) => path === "/web/session/binding")).toHaveLength(2);
  expect(contexts).toEqual(["?context=transactions", ""]);
};
const returnToHandoffAfterCollection = (page: Page, reads: ReadonlyArray<string>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      // A live canonical owner must survive collection of temporary lookup objects.
      const devtools = yield* Effect.tryPromise(() => page.context().newCDPSession(page));
      yield* Effect.tryPromise(() => devtools.send("HeapProfiler.collectGarbage"));
      yield* Effect.tryPromise(() => devtools.detach());
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Transacciones", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeEnabled()
      );
      expect(reads.filter((path) => path === "/transactions")).toHaveLength(0);
      expect(reads.filter((path) => path === "/web/consent")).toHaveLength(1);
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Recurrentes", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Nuevo recurrente", exact: true })).toBeEnabled()
      );
    })
  );
test("reuses the latched session and recent profile and categories across workspaces", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInNavigationPerformanceThroughCore({
          page,
          request,
          identity: "navigationTransactions",
        })
      );
      // Hold only the display freshness clock fixed; the server still checks live authority.
      yield* freezeDisplayClock(page);
      const reads = observeSuccessfulReads(page);
      const bindingContexts: Array<string> = [];
      let seriesReads = 0;
      page.on("request", (read) => {
        const url = new URL(read.url());
        if (url.pathname === "/web/session/binding") bindingContexts.push(url.search);
        if (url.pathname === "/recurring-series") seriesReads += 1;
      });
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeEnabled()
      );
      expectEntryRecheck(reads, bindingContexts);
      for (const workspace of [
        { name: "Presupuestos", ready: "Mes anterior" },
        { name: "Recurrentes", ready: "Nuevo recurrente" },
      ]) {
        yield* Effect.tryPromise(() =>
          page.getByRole("link", { name: workspace.name, exact: true }).click()
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("button", { name: workspace.ready, exact: true })).toBeEnabled()
        );
      }
      yield* Effect.tryPromise(() => returnToHandoffAfterCollection(page, reads));
      expect(reads.filter((path) => path === "/user")).toHaveLength(0);
      expect(reads.filter((path) => path === "/categories")).toHaveLength(0);
      expect(reads.filter((path) => path === "/budgets")).toHaveLength(0);
      expect(reads.filter((path) => path === "/budget-status")).toHaveLength(1);
      expect(seriesReads).toBe(0);
      expect(reads.filter((path) => path === "/recurring-plans")).toHaveLength(1);
      expect(
        reads.filter((path) => /^\/ingestion\/review-workspace\/[^/]+$/u.test(path))
      ).toHaveLength(0);
      yield* Effect.tryPromise(() =>
        page.getByText("Patrones detectados", { exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("heading", { name: "Revisión de patrones", exact: true })
        ).toBeVisible()
      );
      expect(reads.filter((path) => path === "/recurring-series")).toHaveLength(1);
    })
  ));
test("saving a Review draft refreshes its revision without rereading the original", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInNavigationPerformanceThroughCore({ page, request, identity: "navigationDashboard" })
      );
      let originals = 0;
      page.on("request", (read) => {
        if (new URL(read.url()).pathname.endsWith("/material")) originals += 1;
      });
      const initialMaterial = page.waitForResponse(isMaterialRead);
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() => initialMaterial);
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Valor", { exact: true })).toBeEnabled()
      );
      const before = originals;
      const revisedWorkspace = page.waitForResponse(isWorkspaceRead);
      yield* Effect.tryPromise(() => page.getByLabel("Valor", { exact: true }).fill("13250"));
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Borrador guardado", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() => revisedWorkspace);
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Valor", { exact: true })).toBeEnabled()
      );
      expect(originals).toBe(before);
    })
  ));
test("coalesces Review focus refreshes already in flight", ({ page, request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInNavigationPerformanceThroughCore({
          page,
          request,
          identity: "navigationDashboard",
        })
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Valor", { exact: true })).toBeEnabled({ timeout: 25000 })
      );
      let reads = 0;
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const routeRead = (route: Route): Promise<void> => {
        // The navigation badge owns a separate counts-only projection.
        if (new URL(route.request().url()).searchParams.get("limit") === "0") {
          return route.continue();
        }
        reads += 1;
        return holdRead({ reached, release })(route);
      };
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, routeRead)
      );
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
      yield* Effect.tryPromise(() => dispatchFocus(page));
      yield* Deferred.await(reached);
      yield* Effect.tryPromise(() => dispatchVisibility(page));
      // Keep the first response held while a second event has time to reach the query owner.
      yield* Effect.sleep("100 millis");
      expect(reads).toBe(1);
      const completed = page.waitForResponse(isWorkspaceRead);
      yield* Deferred.succeed(release, undefined);
      yield* Effect.tryPromise(() => completed);
    }).pipe(Effect.scoped)
  ));
const holdRead =
  ({
    reached,
    release,
  }: Readonly<{
    reached: Deferred.Deferred<void>;
    release: Deferred.Deferred<void>;
  }>): ((route: Route) => Promise<void>) =>
  (route) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Deferred.succeed(reached, undefined);
        yield* Deferred.await(release);
        yield* Effect.tryPromise(() => route.continue());
      })
    );
test("keeps the current information visible until first Recurring data is ready", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInNavigationPerformanceThroughCore({ page, request, identity: "navigationRecurring" })
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeEnabled()
      );
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/recurring-plans**`, holdRead({ reached, release }))
      );
      const navigation = page.getByRole("link", { name: "Recurrentes", exact: true }).click();
      yield* Deferred.await(reached);
      yield* expectRetainedWorkspaceDuringRead(page).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined))
      );
      yield* Effect.tryPromise(() => navigation);
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Nuevo recurrente", exact: true })).toBeEnabled()
      );
    })
  ));

const freezeDisplayClock = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.flatMap(Clock.currentTimeMillis, (time) =>
    Effect.tryPromise(() => page.clock.setFixedTime(time))
  );
const expectRetainedWorkspaceDuringRead = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeVisible()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Cargando recurrentes", { exact: true })).not.toBeVisible()
    );
  });
