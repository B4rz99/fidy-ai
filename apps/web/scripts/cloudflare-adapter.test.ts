import { describe, expect, it } from "vitest";

const cloudflareRoot = `${process.cwd()}/cloudflare`;

describe("Cloudflare static hosting adapter", () => {
  it("serves the plain web artifact with SPA fallback and no Worker entrypoint", async () => {
    const configuration: unknown = await Bun.file(`${cloudflareRoot}/wrangler.json`).json();

    expect(configuration).not.toHaveProperty("main");
    expect(configuration).toMatchObject({
      assets: {
        directory: "../dist",
        html_handling: "none",
        not_found_handling: "single-page-application",
      },
      name: "fidy-web",
      preview_urls: true,
      workers_dev: true,
      routes: [{ pattern: "fidyapp.com", custom_domain: true }],
    });
  });

  it("allows only the production API and applies production security and cache policy", async () => {
    const headers = await Bun.file(`${cloudflareRoot}/production/_headers`).text();

    expect(headers).toContain("connect-src https://api.fidyapp.com");
    expect(headers).not.toContain("connect-src 'none'");
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toContain("worker-src 'none'");
    expect(headers).not.toContain("X-Robots-Tag: noindex");
    expect(headers).toContain("Cache-Control: no-cache");
    expect(headers).toContain("Cache-Control: public, max-age=31536000, immutable");
  });

  it("denies network access and applies separate preview security and cache policy", async () => {
    const headers = await Bun.file(`${cloudflareRoot}/public/_headers`).text();

    expect(headers).toContain("connect-src 'none'");
    expect(headers).not.toContain("api.fidyapp.com");
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toContain("worker-src 'none'");
    expect(headers).toContain("X-Robots-Tag: noindex, nofollow");
    expect(headers).toContain("Cache-Control: no-cache");
    expect(headers).toContain("Cache-Control: public, max-age=31536000, immutable");
  });
});
