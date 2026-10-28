import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";

export const getStaticPaths: GetStaticPaths = async () =>
  (await getCollection("docs"))
    .filter((entry) => !entry.data.draft)
    .map((entry) => ({
      params: { slug: entry.id || "index" },
      props: { markdown: `# ${entry.data.title}\n\n${entry.body ?? ""}` },
    }));

export const GET: APIRoute<{ readonly markdown: string }> = ({ props }) =>
  new Response(props.markdown, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
