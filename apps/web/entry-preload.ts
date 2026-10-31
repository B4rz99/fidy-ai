import type { HtmlTagDescriptor, Plugin } from "vite";

const entryModules = [
  "/src/app/render.tsx",
  "/src/app/bound-application.tsx",
  "/src/app/application-frame.tsx",
  "/src/transport/initial-session.ts",
];

/** Fetch shared entry code alongside bootstrap without executing it or loading workspace chunks. */
export const entryPreload = (): Plugin => ({
  name: "entry-preload",
  apply: "build",
  transformIndexHtml: {
    order: "post",
    handler(html, { bundle }) {
      if (bundle === undefined) return [];
      const files = new Set<string>();
      const visit = (name: string): void => {
        if (files.has(name)) return;
        const chunk = bundle[name];
        if (chunk?.type !== "chunk") return;
        files.add(name);
        for (const dependency of chunk.imports) visit(dependency);
      };
      for (const chunk of Object.values(bundle)) {
        if (
          chunk.type === "chunk" &&
          entryModules.some((entry) => chunk.facadeModuleId?.replaceAll("\\", "/").endsWith(entry))
        ) {
          visit(chunk.fileName);
        }
      }
      const tags: Array<HtmlTagDescriptor> = [];
      for (const name of files) {
        if (html.includes(`href="/${name}"`)) continue;
        tags.push({
          tag: "link",
          attrs: { rel: "modulepreload", crossorigin: "", href: `/${name}`, fetchpriority: "low" },
          injectTo: "head-prepend",
        });
      }
      return tags;
    },
  },
});
