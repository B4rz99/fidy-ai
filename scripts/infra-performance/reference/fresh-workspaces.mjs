import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Option, Schema } from "effect";

/** @typedef {import("@playwright/test").Page} Page */
/** @typedef {import("@playwright/test").Response} BrowserResponse */
/** @typedef {{page: Page, api: string, browser: string, event: (row: Readonly<Record<string, unknown>>) => void}} Workspace */
const categories = 16,
  cap = "100000",
  width = 12,
  success = 200;

const currencies = ["COP", "USD"];

const money = Schema.Struct({ amount: Schema.String, currency: Schema.String });

const budgetReport = Schema.decodeUnknownSync(
  Schema.Struct({
    data: Schema.Struct({
      period: Schema.Struct({ from: Schema.String, to: Schema.String, timeZone: Schema.String }),
      statuses: Schema.Array(
        Schema.Struct({
          budget: Schema.Struct({
            id: Schema.String,
            categoryId: Schema.String,
            groupName: Schema.String,
            cap: money,
          }),
          type: Schema.String,
          spent: money,
          remaining: money,
        })
      ),
    }),
  })
);

const wire = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * @param {BrowserResponse} reply Actual measured response.
 */
const consumeSuccess = async (reply) => {
  assert.equal(reply.status(), success);
  const body = await reply.body();

  return {
    value: wire(body.toString("utf8")),
    http: {
      status: reply.status(),
      bytes: body.length,
      httpMs: reply.request().timing().responseEnd,
      digest: createHash("sha256").update(body).digest("hex"),
    },
  };
};

/** @param {BrowserResponse} reply Actual measured response. */
export const consumed = (reply) => {
  if (reply.status() !== success) process.stderr.write("REFERENCE_HTTP " + reply.status() + "\n");

  return consumeSuccess(reply);
};

/**
 * @param {Workspace} input Installed application and evidence sink.
 * @param {string} path Expected canonical operation.
 * @param {Record<string, string | null>} query Required or absent query parameters.
 */
export const responseFor = ({ page, api }, path, query) =>
  page.waitForResponse((reply) => {
    const url = new URL(reply.url());

    return (
      reply.request().method() === "GET" &&
      url.origin === api &&
      url.pathname === path &&
      Object.entries(query).every(([name, value]) => url.searchParams.get(name) === value)
    );
  });

/** @param {Page} page Mounted browser page. */
export const painted = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );

/** @param {number} ordinal Fixture record ordinal. */
const digits = (ordinal) => String(ordinal).padStart(width, "0");

/** @param {unknown} value Actual November status response. */
const verifyBudgets = (value) => {
  const { period, statuses } = budgetReport(value).data;
  assert.equal(Date.parse(period.from), Date.parse("2026-11-01T05:00:00Z"));
  assert.equal(Date.parse(period.to), Date.parse("2026-12-01T05:00:00Z"));
  assert.equal(period.timeZone, "America/Bogota");
  assert.equal(statuses.length, currencies.length * categories);

  /** @type {Record<string, string>[]} */
  const outflows = [
    { 1: "2000", 4: "1000", 6: "1000" },
    { 1: "1000", 7: "1000", 9: "1000" },
  ];

  for (const [index, currency] of currencies.entries()) {
    for (let category = 1; category <= categories; category++) {
      const id = "82000000-0000-4000-8000-" + digits(index * categories + category);
      const row = statuses.find(({ budget }) => budget.id === id);
      assert.ok(row, "Missing seeded Budget");
      assert.equal(row.budget.categoryId, "10000000-0000-4000-8000-" + digits(category));
      assert.equal(row.budget.groupName, "Grupo " + currency);
      assert.deepEqual(row.budget.cap, { amount: cap, currency });
      assert.equal(row.type, "under");
      const amount = outflows[index][String(category)] ?? "0";
      assert.deepEqual(row.spent, { amount, currency });
      assert.deepEqual(row.remaining, { amount: String(Number(cap) - Number(amount)), currency });
    }
  }
};

/**
 * @param {Page} page Mounted browser page.
 * @param {string[]} totals Expected spend per group in declared Currency order.
 */
const usableBudgets = async (page, totals) => {
  await Promise.all(
    currencies.map(async (currency, index) => {
      const group = page.getByRole("region", {
        name: "Grupo Grupo " + currency + " " + currency,
        exact: true,
      });

      const spend = group
        .locator(".budget-group-figures .budget-value")
        .filter({ hasText: "Gastado" });

      await spend
        .filter({ hasText: new RegExp(currency + "\\s+" + totals[index] + "(?:,00)?$") })
        .waitFor();
      await page.waitForFunction(
        ({ currency, count }) => {
          const section = document.querySelector(
            '[aria-label="Grupo Grupo ' + currency + " " + currency + '"]'
          );

          const fields =
            section === null
              ? []
              : [...section.getElementsByTagName("input")].filter((item) =>
                  item.matches('[aria-label^="Presupuesto de "]:enabled')
                );

          return (
            section !== null &&
            fields.length === count &&
            fields.every(
              (item) => /^100[.]?000(?:,00)?$/u.test(item.value) && item.getClientRects().length > 0
            )
          );
        },
        { currency, count: categories }
      );
    })
  );
  await painted(page);
};

/** @param {Workspace} input Installed application and evidence sink. */
export const freshBudgetMonth = async (input) => {
  const { page, browser, event } = input;
  await page.goto(browser + "/app/budgets?month=2026-10", { waitUntil: "commit" });
  await usableBudgets(page, ["0", "0"]);

  const response = responseFor(input, "/budget-status", {
    month: "2026-11",
    timeZone: "America/Bogota",
  });

  const journey = "budgets.month.browser";
  event({ type: "offered", journey });
  const start = performance.now();
  await page.getByRole("button", { name: "Mes siguiente", exact: true }).click();
  const reply = await response;
  await usableBudgets(page, ["4[.]?000", "3[.]?000"]);
  const milliseconds = performance.now() - start;
  const { value, http } = await consumed(reply);
  verifyBudgets(value);
  event({ type: "completed", journey, milliseconds, http });

  return { milliseconds, http };
};

const reviewCount = 4,
  inbox = "/ingestion/review-workspace";

const reviewItem = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  source: Schema.String,
  reason: Schema.String,
  timeZone: Schema.String,
});

const reviewPage = Schema.decodeUnknownSync(
  Schema.Struct({
    data: Schema.Struct({
      total: Schema.Int,
      pendingCount: Schema.Int,
      items: Schema.Array(reviewItem),
    }),
  })
);

const pageContext = Schema.decodeUnknownSync(
  Schema.Struct({
    data: Schema.Struct({
      items: Schema.Array(
        Schema.Struct({ id: Schema.String, reference: Schema.String, excerpt: Schema.String })
      ),
    }),
  })
);

const reviewRows = Array.from({ length: reviewCount }, (_, ordinal) => ({
  id: "87000000-0000-4000-8000-" + digits(ordinal),
  reference: "Fila " + (ordinal + 1),
  excerpt: "Original sintético " + ordinal + ": 2026-10-01,25000,Mercado",
}));

/**
 * @param {unknown} value Fresh summary.
 * @param {unknown} context Browser-authorized source references and excerpts.
 */
const verifyPending = (value, context) => {
  const { total, pendingCount, items } = reviewPage(value).data;
  assert.equal(total, reviewCount);
  assert.equal(pendingCount, reviewCount);
  assert.deepEqual(
    items,
    reviewRows.map(({ id }) => ({
      id,
      status: "pending",
      source: "statement",
      reason: "mapping-unavailable",
      timeZone: "America/Bogota",
    }))
  );
  assert.deepEqual(pageContext(context).data.items, reviewRows);
};

/** @param {Page} page Mounted browser page. */
const usableReviews = async (page) => {
  await page.waitForFunction((expected) => {
    const cards = document.querySelectorAll('[data-review="inbox-row"]');

    return (
      cards.length === expected.length &&
      expected.every(({ reference, excerpt }, index) => {
        const card = cards[index];
        const open = card.querySelector('button[data-review="row-content"]:enabled');

        return (
          open?.getAttribute("aria-label") === "Abrir Extracto " + reference &&
          open.getClientRects().length > 0 &&
          card.querySelector('[data-review="context-excerpt"]')?.textContent === excerpt &&
          card.querySelector(
            '[role="checkbox"][aria-checked="false"]:not([aria-disabled="true"]):not([data-disabled])'
          ) !== null
        );
      })
    );
  }, reviewRows);
  await painted(page);
};

const reviewJourney = "review.pending.browser";

const reviewError = Schema.decodeUnknownOption(
  Schema.Struct({
    error: Schema.Struct({ code: Schema.Literals(["rate_limited", "quota_exhausted"]) }),
  })
);

const reviewPressure = Schema.decodeUnknownOption(
  Schema.Literals(["bucket", "leases", "both", "neither"])
);

/** @typedef {"review-history" | "review-summary" | "review-context" | "review-count"} ReviewResponse */
/**
 * @param {BrowserResponse} reply First failed measured response.
 * @param {ReviewResponse} reviewResponse Selected canonical read.
 * @param {Workspace["event"]} event Metadata-only evidence sink.
 */
const failReview = async (reply, reviewResponse, event) => {
  const httpStatus = reply.status();

  const pressureAfterResponse = Option.getOrElse(
    reviewPressure(reply.headers()["x-reference-review-pressure"]),
    () => "unobserved"
  );

  const failure = reviewError(await reply.json().catch(() => undefined));

  const errorCode = Option.match(failure, {
    onNone: () => "unclassified",
    onSome: (body) => body.error.code,
  });

  event({
    type: "failed",
    journey: reviewJourney,
    reviewResponse,
    httpStatus,
    errorCode,
    pressureAfterResponse,
  });
  process.stderr.write(
    `REFERENCE_HTTP GET ${httpStatus} ${reviewResponse} ${errorCode} ${pressureAfterResponse}\n`
  );
  throw new Error(`Needs Review ${reviewResponse} failed with HTTP ${httpStatus}`);
};

/** @param {Workspace} input Installed application and evidence sink. */
const measurePendingReview = async (input) => {
  const { page, browser, event } = input;

  const [historical] = await Promise.all([
    responseFor(input, inbox, { status: "history", limit: null, offset: null }),
    page.goto(browser + "/app/needs-review?status=history", { waitUntil: "commit" }),
  ]);

  const unselected = reviewPage((await consumeSuccess(historical)).value).data;
  assert.equal(unselected.total, 0);
  assert.equal(unselected.pendingCount, reviewCount);
  assert.deepEqual(unselected.items, []);
  await page.getByRole("button", { name: "Historial", pressed: true, exact: true }).waitFor();
  const workspace = responseFor(input, inbox, { status: "pending", limit: null, offset: null });

  const source = responseFor(input, inbox + "/context", {
    status: "pending",
    limit: null,
    offset: null,
  });

  event({ type: "offered", journey: reviewJourney });
  const start = performance.now();

  const [reply, context] = await Promise.all([
    workspace,
    source,
    page.getByRole("button", { name: /^Pendientes/u }).click(),
  ]);

  await usableReviews(page);
  const milliseconds = performance.now() - start;
  const [summary, original] = await Promise.all([consumeSuccess(reply), consumeSuccess(context)]);
  verifyPending(summary.value, original.value);

  return { milliseconds, http: summary.http, context: original.http };
};

/**
 * @param {BrowserResponse} reply Browser reply during the journey.
 * @param {string} api Installed API origin.
 * @returns {ReviewResponse | undefined} Fixed failed read label, including navigation count.
 */
const failedReviewRead = (reply, api) => {
  if (reply.status() === success || reply.request().method() !== "GET") return;
  const url = new URL(reply.url());

  if (url.origin !== api) return;

  if (url.pathname === inbox + "/context") return "review-context";

  if (url.pathname !== inbox) return;

  if (url.searchParams.get("limit") === "0") return "review-count";

  return url.searchParams.get("status") === "history" ? "review-history" : "review-summary";
};

/** @param {Workspace} input Installed application and evidence sink. */
export const freshPendingReview = async (input) => {
  /** @type {Promise<never> | undefined} */
  let firstFailure;
  /** @type {((refusal: Promise<never>) => void) | undefined} */
  let signalFailure;

  /** @type {Promise<never>} */
  const failure = new Promise((resolve) => {
    signalFailure = resolve;
  });

  /** @param {BrowserResponse} reply Observed response before a client retry or dependent request. */
  const capture = (reply) => {
    const name = failedReviewRead(reply, input.api);

    if (name && !firstFailure) {
      firstFailure = failReview(reply, name, input.event);
      signalFailure?.(firstFailure);
    }
  };

  input.page.on("response", capture);

  try {
    const result = await Promise.race([failure, measurePendingReview(input)]);

    if (firstFailure) return await firstFailure;
    input.event({ type: "completed", journey: reviewJourney, ...result });

    return result;
  } catch (error) {
    if (firstFailure) return await firstFailure;
    throw error;
  } finally {
    input.page.off("response", capture);
  }
};
