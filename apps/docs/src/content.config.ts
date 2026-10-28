import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({
    loader: docsLoader({
      generateId: ({ entry }) =>
        entry
          .replace(/(?:^|\/)index\.md$/u, "")
          .replace(/\.md$/u, "")
          .toLowerCase() || "index",
    }),
    schema: docsSchema(),
  }),
};
