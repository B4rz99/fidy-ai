import { Deferred, Effect } from "effect";
import type { Page, Response, Route } from "@playwright/test";
import { apiOrigin } from "./http-fixtures";
import { playwright } from "./playwright-runtime";
import { signInNavigationPerformanceThroughCore } from "./real-core-fixture";

const { test, expect } = playwright;
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

const delayReviewRead = (route: Route): Promise<void> =>
  Effect.runPromise(
    Effect.sleep("500 millis").pipe(Effect.andThen(Effect.tryPromise(() => route.continue())))
  );

const expectReadCount = (count: () => number): Promise<void> => expect.poll(count).toBe(1);

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

const returnToHandoffAfterCollection = async (
  page: Page,
  reads: ReadonlyArray<string>
): Promise<void> => {
  // A live canonical owner must survive collection of temporary lookup objects.
  const devtools = await page.context().newCDPSession(page);
  await devtools.send("HeapProfiler.collectGarbage");
  await devtools.detach();
  await page.getByRole("link", { name: "Transacciones", exact: true }).click();
  await expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeEnabled();
  expect(reads.filter((path) => path === "/transactions")).toHaveLength(0);
  expect(reads.filter((path) => path === "/web/consent")).toHaveLength(1);
  await page.getByRole("link", { name: "Recurrentes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Nuevo recurrente", exact: true })).toBeEnabled();
};

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
      yield* Effect.tryPromise(() => page.clock.setFixedTime(new Date()));
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
      const routeRead = (route: Route): Promise<void> => {
        reads += 1;
        return delayReviewRead(route);
      };
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, routeRead)
      );
      yield* Effect.tryPromise(() => dispatchFocus(page));
      const count = (): number => reads;
      yield* Effect.tryPromise(() => expectReadCount(count));
      yield* Effect.tryPromise(() => dispatchVisibility(page));
      yield* Effect.sleep("700 millis");
      expect(reads).toBe(1);
    })
  ));

const holdRead =
  ({
    reached,
    release,
  }: Readonly<{ reached: Deferred.Deferred<void>; release: Deferred.Deferred<void> }>): ((
    route: Route
  ) => Promise<void>) =>
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
      yield* Effect.tryPromise(async () => {
        await expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeVisible();
        await expect(page.getByLabel("Cargando recurrentes", { exact: true })).not.toBeVisible();
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      yield* Effect.tryPromise(() => navigation);
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Nuevo recurrente", exact: true })).toBeEnabled()
      );
    })
  ));
