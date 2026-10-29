import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/** @type {(html: string, name: string) => string} */
const propertyRow = (html, name) => {
  const table = html.match(/<table\b[^>]*>[\s\S]*?<\/table>/u)?.[0];
  assert.ok(table, "Missing property table");
  const rows = Array.from(table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gu), (match) => match[1]);
  const row = rows.find((candidate) => candidate.includes(`<code>${name}</code>`));
  assert.ok(row, `Missing property row: ${name}`);
  return row;
};

/** @type {(html: string, name: string) => void} */
const assertRequired = (html, name) => {
  assert.match(propertyRow(html, name), /<span[^>]*>\s*obligatorio\s*<\/span>/u);
};

await test("readers can identify required transaction fields without interpreting the raw contract", async () => {
  const html = await readFile(
    new URL("../dist/reference/transactions.createtransaction/index.html", import.meta.url),
    "utf8"
  );
  assertRequired(html, "occurredAt");
  assert.match(html, /Cuerpo HTTP/u);
  assert.match(html, /Respuestas y errores/u);
  assert.match(html, /Unavailable/u);
});

await test("the operation catalog provides a searchable domain index without hiding any operation from static readers", async () => {
  const html = await readFile(new URL("../dist/reference/index.html", import.meta.url), "utf8");
  assert.ok(html.includes('aria-label="Filtrar operaciones"'));
  assert.ok(html.includes("Filtrar 62 operaciones"));
  assert.ok(/<h2[^>]*>budgets[\s\S]*?<\/h2>/u.test(html));
  assert.ok(html.includes('href="/reference/transactions.updatetransaction"'));
  assert.ok(html.includes('href="/reference/subscription.cancelsubscription"'));
});

await test("all published schemas remain individually readable with named properties and complete JSON", async () => {
  const html = await readFile(
    new URL("../dist/referencia/esquemas/index.html", import.meta.url),
    "utf8"
  );
  assert.ok(html.includes('aria-label="Buscar por nombre de esquema"'));
  assert.equal(Array.from(html.matchAll(/id="schema-[a-zA-Z0-9_]+"/gu)).length, 286);
  assert.ok(html.includes('id="schema-ValidationFailedEncoded"'));
  assert.ok(html.includes('id="schema-TransactionOccurredAt"'));
  assert.ok(html.includes("JSON completo"));
  assertRequired(html, "cap");
});

await test("path parameters, inline batch permissions and union bodies remain explicit beside request bodies", async () => {
  const update = await readFile(
    new URL("../dist/reference/transactions.updatetransaction/index.html", import.meta.url),
    "utf8"
  );
  assert.ok(update.includes("id (path, obligatorio)"));
  assert.ok(update.includes('id="parametros-http"'));
  assert.ok(update.includes("expectedRevision"));
  const batch = await readFile(
    new URL("../dist/reference/operations.executeatomicbatch/index.html", import.meta.url),
    "utf8"
  );
  assert.ok(batch.includes("Se evalúan los permisos de cada operación del lote."));
  assertRequired(batch, "calls");
  const union = await readFile(
    new URL("../dist/reference/dashboard.applydashboardedit/index.html", import.meta.url),
    "utf8"
  );
  assert.ok(union.includes("Una de estas variantes del contrato:"));
  assert.ok(union.includes("variantes; la definición completa conserva todas sus condiciones."));
});

await test("operations without HTTP parameters retain their explicit empty parameter contract beside the body", async () => {
  const html = await readFile(
    new URL("../dist/reference/transactions.createtransaction/index.html", import.meta.url),
    "utf8"
  );
  assert.ok(html.includes("Esta operación no declara parámetros HTTP."));
  assert.ok(html.includes('id="parametros-http"'));
});

await test("parameter-only operations label their parameter region with its own heading", async () => {
  const html = await readFile(
    new URL("../dist/reference/budgets.listbudgets/index.html", import.meta.url),
    "utf8"
  );
  assert.match(
    html,
    /<section aria-labelledby="parametros-http">\s*<h2 id="parametros-http">\s*Parámetros HTTP\s*<\/h2>/u
  );
});

await test("empty parameter JSON stays keyboard readable without an unconditional scrolling instruction", async () => {
  const html = await readFile(
    new URL("../dist/reference/budgets.listbudgets/index.html", import.meta.url),
    "utf8"
  );
  const parameters = html.match(
    /<section aria-labelledby="parametros-http">[\s\S]*?<\/section>/u
  )?.[0];
  assert.ok(parameters, "Missing parameters region");
  assert.match(parameters, /<pre\b[^>]*tabindex="0"/u);
  assert.match(parameters, /<div class="reference-json-footer" hidden>/u);
});
