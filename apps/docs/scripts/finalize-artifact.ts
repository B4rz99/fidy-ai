import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const distribution = new URL("../dist/", import.meta.url);
for (const entry of readdirSync(distribution, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".html")) continue;
  const path = resolve(entry.parentPath, entry.name);
  const html = readFileSync(path, "utf8");
  const hashes = Array.from(
    html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gu),
    (match) => `'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`
  );
  // Starlight's is:inline scripts retain whitespace that Astro's CSP collector hashes differently.
  // Authorize their exact emitted bytes; browser acceptance checks keep script execution restricted.
  const finalized = html.replace(
    /<meta http-equiv="content-security-policy" content="([^"]+)"/u,
    (meta, policy: string): string =>
      meta.replace(
        policy,
        policy.replace(/script-src ([^;]+)/u, (directive) => `${directive} ${hashes.join(" ")}`)
      )
  );
  if (finalized === html) throw new Error(`Missing script policy in ${entry.name}`);
  writeFileSync(path, finalized);
}
