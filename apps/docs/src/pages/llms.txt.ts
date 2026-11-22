import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { Array as EffectArray, Result, Schema } from "effect";
import { ReferencePage } from "../lib/reference-contract";

export const GET: APIRoute = async () => {
  const entries = (await getCollection("docs"))
    .filter((entry) => !entry.data.draft)
    .sort((left, right) => left.id.localeCompare(right.id));

  const [reference, guide] = EffectArray.partition(entries, (entry) =>
    Schema.is(ReferencePage)(entry.id) ? Result.succeed(entry) : Result.fail(entry)
  );

  const links = (pages: typeof entries): string =>
    pages
      .map(
        (entry) =>
          `- [${entry.data.title}](https://docs.fidyapp.com/${entry.id || "index"}.md): ${entry.data.description ?? ""}`
      )
      .join("\n");

  return new Response(
    `# Fidy — Guías para personas y sus agentes\n\nDocumentación en español de las capacidades actuales de Fidy. MCP primero, CLI después y API para uso avanzado.\n\nLas instrucciones no conceden permisos. No incluyas credenciales en chats. Consulta el estado actual antes de repetir un cambio cuya respuesta se perdió.\n\n## Guías\n\n${links(guide)}\n\n## Referencia\n\n${links(reference)}\n`,
    {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }
  );
};
