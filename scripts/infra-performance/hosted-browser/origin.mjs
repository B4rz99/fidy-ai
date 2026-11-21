import assert from "node:assert/strict";
import { installedOrigins } from "../../../apps/server/src/shell/browser-transport/contract";

const { chromium } = await import("@playwright/test");

const success = 200;

/** @param {string} lines Trace response text. */
export const parseTrace = (lines) => {
  /** @param {string} name Trace field name. */
  const field = (name) =>
    lines
      .split(/\r?\n/u)
      .find((line) => line.startsWith(name + "="))
      ?.slice(name.length + 1);

  const country = field("loc"),
    colo = field("colo"),
    warp = field("warp");

  assert.match(country ?? "", /^[A-Z]{2}$/u);
  assert.match(colo ?? "", /^[A-Z]{3}$/u);

  return { country, colo, warp: warp ?? "unknown" };
};

export const inspectBrowserOrigin = async () => {
  const browser = await chromium.launch({
    executablePath: process.env.ASSESSMENT_CHROMIUM,
    env: { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.RUNNER_TEMP },
    args: ["--no-proxy-server"],
  });

  try {
    const page = await browser.newPage({ serviceWorkers: "block" });

    /** @param {string} host Acceptance host. */
    const inspect = async (host) => {
      const reply = await page.goto(host + "/cdn-cgi/trace", { waitUntil: "load", timeout: 15000 });
      assert.ok(reply);
      assert.equal(reply.status(), success);
      assert.equal(reply.url(), host + "/cdn-cgi/trace");

      return parseTrace(await reply.text());
    };

    const { api, browser: web } = installedOrigins.acceptance;
    const origins = { api: await inspect(api), browser: await inspect(web) };

    return {
      observedAt: new Date().toISOString(),
      chromium: browser.version(),
      origins,
    };
  } finally {
    await browser.close();
  }
};

if (import.meta.main) {
  const report = await inspectBrowserOrigin();
  await Bun.write(process.argv[2], JSON.stringify(report, null, 2));
}
