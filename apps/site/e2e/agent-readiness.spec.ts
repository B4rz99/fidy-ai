import { expect, test } from "@playwright/test";

const ok = 200;
const notFound = 404;
const methodNotAllowed = 405;
const minimumDocumentLength = 500;
const minimumErrorLength = 20;
const mobileWidth = 390;
const desktopWidth = 1440;

const documents = [
  "/",
  "/about",
  "/contact",
  "/privacy",
  "/docs",
  "/politica",
  "/cookies",
  "/terminos",
  "/funciones/transacciones",
  "/funciones/presupuestos",
  "/funciones/asistente",
  "/funciones/tablero",
  "/funciones/insights",
  "/funciones/agentes",
];

for (const path of documents) {
  test(`negotiates complete HTML and Markdown for ${path}`, async ({ request }) => {
    const html = await request.get(path, { headers: { Accept: "text/html" } });
    expect(html.status()).toBe(ok);
    expect(html.headers()["content-type"]).toContain("text/html");
    expect(html.headers()["content-security-policy"]).toContain("default-src 'none'");
    expect(html.headers()["content-security-policy"]).toContain("script-src 'self' 'sha256-");
    expect(html.headers().vary).toMatch(/\bAccept\b/iu);
    const markdown = await request.get(path, { headers: { Accept: "text/markdown" } });
    expect(markdown.status()).toBe(ok);
    expect(markdown.headers()["content-type"]).toContain("text/markdown");
    expect(markdown.headers().vary).toMatch(/\bAccept\b/iu);
    expect(markdown.headers()["x-content-type-options"]).toBe("nosniff");
    const body = await markdown.text();
    expect(body).toMatch(/^# .+/mu);
    expect(body.length).toBeGreaterThan(minimumDocumentLength);
    expect(body).not.toMatch(/<(?:html|script|astro-island)\b/iu);
    const sidecar = await request.get(path === "/" ? "/index.md" : `${path}.md`);
    expect(sidecar.status()).toBe(ok);
    expect(sidecar.headers()["content-type"]).toContain("text/markdown");
    expect(sidecar.headers()["x-robots-tag"]).toBe("noindex");
    expect(await sidecar.text()).toBe(body);
    const head = await request.head(path, { headers: { Accept: "text/markdown" } });
    expect(head.status()).toBe(ok);
    expect(head.headers()["content-type"]).toContain("text/markdown");
    expect(await head.text()).toBe("");
    if (path === "/terminos") expect(markdown.headers()["x-robots-tag"]).toBe("noindex");
  });
}

test("keeps missing pages as 404 in both representations without reflecting input", async ({
  request,
}) => {
  await Promise.all(
    ["text/html", "text/markdown"].map(async (accept) => {
      const response = await request.get("/__ora-404-probe-untrusted?token=do-not-reflect", {
        headers: { Accept: accept },
      });
      expect(response.status()).toBe(notFound);
      expect(response.headers()["content-type"]).toContain(accept);
      expect(response.headers().vary).toMatch(/\bAccept\b/iu);
      const body = await response.text();
      expect(body.length).toBeGreaterThan(minimumErrorLength);
      expect(body).toContain("/llms.txt");
      expect(body).not.toContain("do-not-reflect");
      expect(body).not.toContain("__ora-404-probe-untrusted");
      if (accept === "text/markdown") expect(response.headers()["x-robots-tag"]).toBe("noindex");
    })
  );
});

const preferences = [
  ["text/markdown", "text/markdown"],
  ["TEXT/MARKDOWN; q=1", "text/markdown"],
  ["text/html", "text/html"],
  ["*/*", "text/html"],
  ["text/markdown;q=0, text/html", "text/html"],
  ["text/markdown;q=0.4, text/html;q=0.9", "text/html"],
  ["text/markdown;q=0.9, text/html;q=0.4", "text/markdown"],
  ["text/markdown;q=0, text/*;q=1", "text/html"],
  ["text/markdown;q=invalid, text/html", "text/html"],
  ["text/markdown;q=0.8, text/*;q=0.5", "text/markdown"],
] as const;
for (const [accept, expected] of preferences) {
  test(`honors Accept preferences: ${accept}`, async ({ request }) => {
    const response = await request.get("/", { headers: { Accept: accept } });
    expect(response.headers()["content-type"]).toContain(expected);
  });
}

test("does not reuse an HTML validator or byte range for Markdown", async ({ request }) => {
  const html = await request.get("/");
  const markdown = await request.get("/", {
    headers: {
      Accept: "text/markdown",
      "If-None-Match": html.headers().etag,
      "If-Modified-Since": "Wed, 28 Oct 2099 00:00:00 GMT",
      Range: "bytes=0-9",
    },
  });
  expect(markdown.status()).toBe(ok);
  expect((await markdown.text()).length).toBeGreaterThan(minimumDocumentLength);
  expect(markdown.headers().etag).toBeUndefined();
  expect(markdown.headers()["content-range"]).toBeUndefined();
});

test("keeps unsafe methods and public asset types outside negotiation", async ({ request }) => {
  const rejected = await request.post("/", {
    headers: { Accept: "text/markdown" },
    data: "untrusted",
  });
  expect(rejected.status()).toBe(methodNotAllowed);
  await Promise.all(
    [
      ["/llms.txt", "text/plain"],
      ["/fidy-logo.webp", "image/webp"],
      ["/sitemap-index.xml", "application/xml"],
    ].map(async ([path, type]) => {
      const response = await request.get(path, { headers: { Accept: "text/markdown" } });
      expect(response.status()).toBe(ok);
      expect(response.headers()["content-type"]).toContain(type);
    })
  );
});

test("publishes a parseable llms index with working local links and real OAuth discovery", async ({
  request,
}) => {
  const response = await request.get("/llms.txt");
  const text = await response.text();
  expect(text).toMatch(/^# Fidy/mu);
  expect(text).toMatch(/^> .+/mu);
  expect(text).toContain("When to use Fidy");
  expect(text).toContain("https://api.fidyapp.com/.well-known/oauth-protected-resource/mcp");
  expect(text).toContain("https://api.fidyapp.com/.well-known/oauth-authorization-server");
  for (const section of text.split(/^## .+$/mu).slice(1)) {
    for (const line of section.trim().split("\n").filter(Boolean)) {
      expect(line).toMatch(/^- \[[^\]]+\]\(https:\/\/[^)]+\): .+/u);
    }
  }
  await Promise.all(
    [...text.matchAll(/\]\(https:\/\/fidyapp\.com([^)]+)\)/gu)].map(async (match) => {
      expect((await request.get(match[1])).status()).toBe(ok);
    })
  );
});

for (const width of [mobileWidth, desktopWidth]) {
  test(`keeps hero examples interactive without initial React hydration at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const scripts: string[] = [];
    page.on("request", (request) => {
      if (request.resourceType() === "script") scripts.push(request.url());
    });
    await page.goto("/");
    await expect(page.locator('.demo-shell[data-ready="true"]')).toHaveCount(1);
    expect(scripts.filter((url) => /\/(?:client|react)\./u.test(url))).toEqual([]);
    await page.getByRole("button", { name: "Consultar", exact: true }).click();
    await expect(page.locator(".conversation-frame")).toContainText(
      "¿En qué se me ha ido la plata este mes?"
    );
    await expect(page.getByRole("button", { name: "Consultar", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await page.getByRole("button", { name: "Presupuestar", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Presupuestar", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await page.getByRole("button", { name: "Registrar", exact: true }).click();
    await expect(page.locator(".conversation-frame")).toContainText(
      "Pagué $28.000 de almuerzo en Crepes."
    );
    const images = await page.locator(".hero img, header img").evaluateAll((elements) =>
      elements.map((element) => ({
        width: element.getAttribute("width"),
        height: element.getAttribute("height"),
      }))
    );
    expect(images.every((image) => Number(image.width) > 0 && Number(image.height) > 0)).toBe(true);
    await page.goto("/about");
    await page.goBack();
    await page.getByRole("button", { name: "Consultar", exact: true }).click();
    await expect(page.locator(".conversation-frame")).toContainText(
      "¿En qué se me ha ido la plata este mes?"
    );
  });

  test(`exposes identity, trust pages and agent onboarding at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const identity: unknown = JSON.parse(
      await page.locator('script[type="application/ld+json"]').innerText()
    );
    expect(identity).toMatchObject({
      "@context": "https://schema.org",
      "@graph": expect.arrayContaining([
        expect.objectContaining({
          "@type": "SoftwareApplication",
          name: "Fidy",
          offers: expect.objectContaining({ price: "28900", priceCurrency: "COP" }),
        }),
        expect.objectContaining({
          "@type": "Organization",
          name: "Fidy",
          contactPoint: expect.objectContaining({
            email: "obarboza@fidyapp.com",
            contactType: "customer support",
          }),
          address: {
            "@type": "PostalAddress",
            streetAddress: "Calle 104 #53-49",
            addressLocality: "Barranquilla",
            addressCountry: "CO",
          },
        }),
      ]),
    });
    await expect(page.locator('link[rel="alternate"][type="text/markdown"]')).toHaveAttribute(
      "href",
      "/index.md"
    );
    await page.goto("/docs");
    await expect(
      page.getByRole("link", { name: "metadatos del recurso protegido (RFC 9728)" })
    ).toHaveAttribute("href", "https://api.fidyapp.com/.well-known/oauth-protected-resource/mcp");
    await expect(
      page.getByText("fidy login --recipient 'Mi agente' --scopes read --lifetime 7", {
        exact: true,
      })
    ).toHaveCount(1);
  });
}

for (const width of [mobileWidth, desktopWidth]) {
  for (const path of ["/about", "/contact", "/docs"]) {
    test(`keeps ${path} discoverable and readable at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(page.locator(`footer a[href="${path}"]`)).toHaveCount(1);
      await page.goto(path);
      expect((await page.locator("main").innerText()).length).toBeGreaterThan(
        minimumDocumentLength
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
    });
  }
}

test("verifies public OAuth discovery and keeps MCP tools authenticated", async ({ request }) => {
  test.skip(
    process.env.SITE_PUBLIC_ORIGIN !== "https://fidyapp.com",
    "Live API discovery runs after deployment."
  );
  const metadata = await request.get(
    "https://api.fidyapp.com/.well-known/oauth-protected-resource/mcp"
  );
  expect(metadata.status(), `OAuth discovery: ${metadata.headers()["cf-ray"] ?? "no ray"}`).toBe(
    ok
  );
  expect(metadata.headers()["content-type"]).toContain("application/json");
  expect(await metadata.json()).toMatchObject({
    resource: "https://api.fidyapp.com/mcp",
    authorization_servers: ["https://api.fidyapp.com"],
    scopes_supported: expect.arrayContaining(["read"]),
    bearer_methods_supported: ["header"],
  });
  const authorization = await request.get(
    "https://api.fidyapp.com/.well-known/oauth-authorization-server"
  );
  expect(authorization.status()).toBe(ok);
  expect(await authorization.json()).toMatchObject({
    issuer: "https://api.fidyapp.com",
    scopes_supported: expect.arrayContaining(["read", "write", "dashboard"]),
  });
  const mcp = await request.get("https://api.fidyapp.com/mcp");
  const unauthorized = 401;
  expect(mcp.status()).toBe(unauthorized);
  expect(mcp.headers()["www-authenticate"]).toContain(
    'resource_metadata="https://api.fidyapp.com/.well-known/oauth-protected-resource/mcp"'
  );
});

for (const path of ["/", "/docs", "/funciones/transacciones"]) {
  test(`enforces browser output boundaries at ${path}`, async ({ page }) => {
    const response = await page.goto(path);
    expect(response?.headers()["strict-transport-security"]).toBe(
      "max-age=31536000; includeSubDomains; preload"
    );
    const policy = response?.headers()["content-security-policy"];
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("require-trusted-types-for 'script'");
    expect(policy).toContain("trusted-types 'none'");
    const result = await page.evaluate(() => {
      const container = document.createElement("div");
      let rejected = false;
      try {
        container.innerHTML =
          '<img src="/untrusted-markup" onerror="document.body.dataset.injected=1">';
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        rejected = true;
      }
      return {
        rejected,
        empty: container.childNodes.length === 0,
        injected: document.body.dataset.injected,
      };
    });
    expect(result).toEqual({ rejected: true, empty: true, injected: undefined });
  });
}
