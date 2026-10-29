import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

await test("serves a Spanish task-first documentation home as static HTML", async () => {
  const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  assert.match(html, /lang="es"/u);
  assert.match(html, /Conectar mi agente/u);
  assert.match(html, /Registrar y corregir/u);
  assert.match(html, /Consultar mis finanzas/u);
  assert.match(html, /https:\/\/docs\.fidyapp\.com\//u);
});

await test("readers can return through the Fidy brand and reach agent documentation without product navigation", async () => {
  const html = await readFile(new URL("../dist/conectar/mcp/index.html", import.meta.url), "utf8");
  assert.match(html, /<a[^>]+href="\/"[^>]*>[\s\S]*?<img[^>]+alt="Fidy · Inicio"/u);
  assert.match(html, /href="\/llms\.txt"/u);
  assert.match(html, /href="\/reference"/u);
  assert.doesNotMatch(html, /href="\/(?:dashboard|transactions|budgets)"/u);
});

await test("offers the same guide to readers and agents through Markdown and llms.txt", async () => {
  const markdown = await readFile(new URL("../dist/index.md", import.meta.url), "utf8");
  assert.match(markdown, /# Guía de Fidy/u);
  assert.match(markdown, /Conectar mi agente/u);
  const index = await readFile(new URL("../dist/llms.txt", import.meta.url), "utf8");
  assert.match(index, /https:\/\/docs\.fidyapp\.com\/index\.md/u);
  assert.match(index, /Conectar mi agente/u);
});

await test("all generated documentation and reference links resolve inside the public artifact", async () => {
  const { readdir, access } = await import("node:fs/promises");
  const { resolve, dirname } = await import("node:path");
  const root = new URL("../dist/", import.meta.url).pathname;
  const files = await readdir(root, { recursive: true });
  const htmlFiles = files.filter((file) => file.endsWith(".html"));
  await Promise.all(
    htmlFiles.map(async (file) => {
      const html = await readFile(resolve(root, file), "utf8");
      const paths = Array.from(html.matchAll(/href="(\/[^"#?]*)/gu), (match) => match[1]);
      await Promise.all(
        paths.map(async (path) => {
          assert.ok(path);
          const target = resolve(root, `.${path}`);
          const candidates = [target, resolve(target, "index.html")];
          const outcomes = await Promise.allSettled(
            candidates.map((candidate) => access(candidate))
          );
          assert.ok(
            outcomes.some((outcome) => outcome.status === "fulfilled"),
            `Broken link ${path} in ${dirname(file)}`
          );
        })
      );
    })
  );
});

await test("missing pages contain one recovery heading instead of the default 404 hero", async () => {
  const html = await readFile(new URL("../dist/404.html", import.meta.url), "utf8");
  assert.equal(Array.from(html.matchAll(/<h1\b/gu)).length, 1);
  assert.match(html, /Esta página no está aquí\./u);
});
