import { readdir } from "node:fs/promises";
import TurndownService from "turndown";

const output = new URL("../dist/", import.meta.url);
const converter = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
converter.remove((node) => ["SCRIPT", "STYLE", "SVG", "BUTTON", "HEAD"].includes(node.nodeName));
await Promise.all(
  (await readdir(output, { recursive: true }))
    .filter((path) => path.endsWith(".html"))
    .map(async (path) => {
      const html = await Bun.file(new URL(path, output)).text();
      const markdown = converter.turndown(html);
      await Bun.write(new URL(path.replace(/\.html$/u, ".md"), output), `${markdown}\n`);
    })
);
