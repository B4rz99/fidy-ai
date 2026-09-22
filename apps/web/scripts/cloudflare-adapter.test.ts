import { describe, expect, it } from "vitest";

const cloudflareRoot = `${process.cwd()}/cloudflare`;

const matchingLines = (text: string, value: string): ReadonlyArray<string> =>
  text.split("\n").filter((line) => line.trim() === value);

const expectStaticSecurityHeaders = (headers: string): void => {
  expect(matchingLines(headers, "Cross-Origin-Opener-Policy: same-origin")).toHaveLength(1);
  expect(matchingLines(headers, "Cross-Origin-Resource-Policy: same-origin")).toHaveLength(1);
  expect(matchingLines(headers, "Referrer-Policy: no-referrer")).toHaveLength(1);
  expect(matchingLines(headers, "X-Content-Type-Options: nosniff")).toHaveLength(1);
  expect(matchingLines(headers, "X-Frame-Options: DENY")).toHaveLength(1);
};

describe("Cloudflare static artifact policy", () => {
  it("keeps the Wrangler adapter restricted to pull-request previews", async () => {
    const configuration: unknown = await Bun.file(`${cloudflareRoot}/wrangler.json`).json();

    expect(configuration).not.toHaveProperty("main");
    expect(configuration).not.toHaveProperty("routes");
    expect(configuration).toMatchObject({
      assets: {
        directory: "../dist",
        html_handling: "none",
        not_found_handling: "single-page-application",
      },
      name: "fidy-web-preview",
      preview_urls: true,
      workers_dev: true,
    });
  });

  it("allows only the production API and applies production security and cache policy", async () => {
    const headers = await Bun.file(`${cloudflareRoot}/production/_headers`).text();

    expect(headers).toContain("connect-src https://api.fidyapp.com");
    expect(headers).not.toContain("connect-src 'none'");
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toContain("worker-src 'none'");
    expectStaticSecurityHeaders(headers);
    expect(headers).not.toContain("X-Robots-Tag: noindex");
    expect(matchingLines(headers, "Cache-Control: no-cache")).toHaveLength(1);
    expect(matchingLines(headers, "! Cache-Control")).toHaveLength(1);
    expect(
      matchingLines(headers, "Cache-Control: public, max-age=31536000, immutable")
    ).toHaveLength(1);
  });

  it("denies network access and applies separate preview security and cache policy", async () => {
    const headers = await Bun.file(`${cloudflareRoot}/public/_headers`).text();

    expect(headers).toContain("connect-src 'none'");
    expect(headers).not.toContain("api.fidyapp.com");
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toContain("worker-src 'none'");
    expectStaticSecurityHeaders(headers);
    expect(headers).toContain("X-Robots-Tag: noindex, nofollow");
    expect(matchingLines(headers, "Cache-Control: no-cache")).toHaveLength(1);
    expect(matchingLines(headers, "! Cache-Control")).toHaveLength(1);
    expect(
      matchingLines(headers, "Cache-Control: public, max-age=31536000, immutable")
    ).toHaveLength(1);
  });
});
