import { readdir } from "node:fs/promises";

const output = new URL("../dist/", import.meta.url);
const base = await Bun.file(new URL("../public/_headers", import.meta.url)).text();
const documents = (await readdir(output, { recursive: true })).filter((path) =>
  path.endsWith(".html")
);
const policies = await Promise.all(
  documents.map(async (path) => {
    const html = await Bun.file(new URL(path, output)).text();
    const policy = /<meta http-equiv="content-security-policy" content="([^"]+)"/u.exec(html)?.[1];
    if (policy === undefined) throw new Error(`Missing document CSP: ${path}`);
    const headers = `${policy} frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'`;
    const route = path === "index.html" ? "/" : `/${path.replace(/\.html$/u, "")}`;
    return [route, `/${path}`]
      .map((url) => `${url}\n  ! Content-Security-Policy\n  Content-Security-Policy: ${headers}\n`)
      .join("\n");
  })
);
await Bun.write(new URL("_headers", output), `${base}\n${policies.join("\n")}`);
