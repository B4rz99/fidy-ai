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
