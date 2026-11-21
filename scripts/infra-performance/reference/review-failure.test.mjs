import assert from "node:assert/strict";
import { freshPendingReview } from "./fresh-workspaces.mjs";

const { chromium } = await import("@playwright/test");

const browser = await chromium.launch({ executablePath: process.env.ASSESSMENT_CHROMIUM });

const timeoutMs = 3000;

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(timeoutMs);
  const origin = "https://review.test";
  const events = [];
  let countFails = false;
  const path = "/ingestion/review-workspace";
  await page.route(origin + "/**", async (route) => {
    const url = new URL(route.request().url());

    if (url.pathname.startsWith("/app/")) {
      await route.fulfill({
        contentType: "text/html",
        body: `
        <button aria-pressed="true">Historial</button>
        <button id="select">Pendientes</button>
        <script>
          fetch("${path}?status=history");
          select.onclick = async () => {
            await fetch("${path}?status=pending&limit=0");
            await fetch("${path}?status=pending");
          };
        </script>`,
      });
    } else if (
      url.searchParams.get("status") === "history" ||
      (url.searchParams.has("limit") && !countFails)
    ) {
      await route.fulfill({ json: { data: { total: 0, pendingCount: 4, items: [] } } });
    } else {
      await route.fulfill({
        status: 429,
        headers: { "x-reference-review-pressure": "bucket" },
        json: { error: { code: "rate_limited", message: "private detail" } },
      });
    }
  });
  await assert.rejects(
    freshPendingReview({ page, browser: origin, api: origin, event: (row) => events.push(row) }),
    /HTTP 429/u
  );
  assert.deepEqual(events, [
    { type: "offered", journey: "review.pending.browser" },
    {
      type: "failed",
      journey: "review.pending.browser",
      reviewResponse: "review-summary",
      httpStatus: 429,
      errorCode: "rate_limited",
      pressureAfterResponse: "bucket",
    },
  ]);
  countFails = true;
  events.length = 0;
  await assert.rejects(
    freshPendingReview({ page, browser: origin, api: origin, event: (row) => events.push(row) }),
    /HTTP 429/u
  );
  assert.equal(events[1]?.reviewResponse, "review-count");
} finally {
  await browser.close();
}
