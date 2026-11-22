import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import TurndownService from "turndown";

const output = new URL("../dist/", import.meta.url);

const converter = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

converter.remove((node) => ["SCRIPT", "STYLE", "SVG", "BUTTON", "HEAD"].includes(node.nodeName));

for (const path of readdirSync(output, { recursive: true, encoding: "utf8" })) {
  if (!path.endsWith(".html")) continue;
  const markdown = converter.turndown(readFileSync(new URL(path, output), "utf8"));
  writeFileSync(new URL(path.replace(/\.html$/u, ".md"), output), `${markdown}\n`);
}
