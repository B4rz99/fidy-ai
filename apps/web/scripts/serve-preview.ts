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
  ".map": "application/json; charset=utf-8",
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

const responseFor = async (request: Request): Promise<Response> => {
  const pathname = new URL(request.url).pathname;
  const candidate = filePath(pathname);
  if (Option.isNone(candidate)) return new Response(null, { status: 400 });

  const file = Bun.file(candidate.value);
  if (await file.exists()) {
    const extension = candidate.value.slice(candidate.value.lastIndexOf(".")).toLowerCase();
    return new Response(file, {
      headers: { "content-type": contentTypes[extension] ?? "application/octet-stream" },
    });
  }

  if (pathname.includes(".")) return new Response(null, { status: 404 });
  const shell = Bun.file(`${root}/index.html`);
  return new Response(shell, { headers: { "content-type": "text/html; charset=utf-8" } });
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  tls: { cert: Bun.file(tlsCertificate), key: Bun.file(tlsKey) },
  fetch: responseFor,
});

process.stdout.write(`Static preview server listening at ${server.url}\n`);
