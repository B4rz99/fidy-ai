import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";
import { Option } from "effect";

const root = Bun.env.PREVIEW_ROOT ?? "playwright-dist";
const port = Number.parseInt(Bun.env.PREVIEW_PORT ?? "4173", 10);
const tlsKey = Bun.env.PLAYWRIGHT_TLS_KEY;
const tlsCertificate = Bun.env.PLAYWRIGHT_TLS_CERT;

if (tlsKey === undefined || tlsCertificate === undefined) {
  throw new Error("Preview TLS key and certificate are required");
}

const contentTypes: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const filePath = (pathname: string): Option.Option<string> => {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return Option.none();
  }
  if (decodedPath.includes("\\") || decodedPath.includes("\0")) return Option.none();

  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^[/]+/u, "");
  if (relativePath.split("/").some((segment) => segment === "..")) return Option.none();
  return Option.some(`${root}/${relativePath}`);
};

// The acceptance host applies the Production _headers policy, changing only its API origin to
// the separate loopback TLS fixture. Missing or unexpected policy fails before serving anything.
const policy = await Bun.file(new URL("../cloudflare/production/_headers", import.meta.url)).text();
const apiOrigin = browserAcceptanceTopology().api;
const productionOrigin = "https://api.fidyapp.com";
if (policy.split(productionOrigin).length !== 2 || !policy.includes("/assets/*")) {
  throw new Error("Production security policy is missing or ambiguous");
}
const [shellPolicy, assetPolicy] = policy.replace(productionOrigin, apiOrigin).split("/assets/*");
if (shellPolicy === undefined || assetPolicy === undefined) {
  throw new Error("Production security policy is malformed");
}
const policyHeaders = Object.fromEntries(
  shellPolicy.split("\n").flatMap((line): ReadonlyArray<readonly [string, string]> => {
    const match = /^  ([\w-]+): (.+)$/u.exec(line);
    return match?.[1] === undefined || match[2] === undefined ? [] : [[match[1], match[2]]];
  })
);
const assetCache = /^  Cache-Control: (.+)$/mu.exec(assetPolicy)?.[1];
if (policyHeaders["Content-Security-Policy"] === undefined || assetCache === undefined) {
  throw new Error("Production security policy lacks security or asset caching rules");
}

const responseFor = (request: Request): Promise<Response> => {
  const pathname = new URL(request.url).pathname;
  const candidate = filePath(pathname);
  if (Option.isNone(candidate)) {
    return Promise.resolve(new Response(null, { status: 400, headers: policyHeaders }));
  }
  if (pathname.endsWith(".map")) {
    return Promise.resolve(new Response(null, { status: 404, headers: policyHeaders }));
  }

  const file = Bun.file(candidate.value);
  return file.exists().then((exists) => {
    if (exists) {
      const extension = candidate.value.slice(candidate.value.lastIndexOf(".")).toLowerCase();
      return new Response(file, {
        headers: {
          ...policyHeaders,
          ...(pathname.startsWith("/assets/") ? { "Cache-Control": assetCache } : {}),
          "content-type": contentTypes[extension] ?? "application/octet-stream",
        },
      });
    }
    if (pathname.includes(".")) return new Response(null, { status: 404, headers: policyHeaders });
    const shell = Bun.file(`${root}/index.html`);
    return new Response(shell, {
      headers: { ...policyHeaders, "content-type": "text/html; charset=utf-8" },
    });
  });
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  tls: { cert: Bun.file(tlsCertificate), key: Bun.file(tlsKey) },
  fetch: (request) =>
    request.method === "GET" || request.method === "HEAD"
      ? responseFor(request)
      : new Response(null, { status: 405, headers: policyHeaders }),
});

process.stdout.write(`Static preview server listening at ${server.url}\n`);
