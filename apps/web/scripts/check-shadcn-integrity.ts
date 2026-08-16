#!/usr/bin/env bun

import { Schema } from "effect";

const ComponentsConfig = Schema.Struct({
  aliases: Schema.Struct({
    components: Schema.String,
    ui: Schema.String,
    utils: Schema.String,
  }),
});

const webRoot = Bun.fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const config = Schema.decodeUnknownSync(ComponentsConfig)(
  await Bun.file(`${webRoot}/components.json`).json()
);
if (
  config.aliases.components !== "@/ui/components" ||
  config.aliases.ui !== "@/ui/components" ||
  config.aliases.utils !== "@/ui/class-names"
) {
  throw new Error(
    "Shadcn aliases must target @/ui/components and the ownerless @/ui/class-names utility"
  );
}

const result = Bun.spawnSync(["bunx", "--bun", "shadcn", "add", "button", "--dry-run"], {
  cwd: webRoot,
  stderr: "pipe",
  stdout: "pipe",
});
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const report = `${decode(result.stdout)}\n${decode(result.stderr)}`;
if (result.exitCode !== 0) {
  throw new Error(`Shadcn dry run failed:\n${report}`);
}
if (!report.includes("src/ui/components/button.tsx")) {
  throw new Error(`Shadcn dry run did not resolve src/ui/components/button.tsx:\n${report}`);
}
if (report.includes("@/ui/button.tsx") || report.includes("apps/web/@/")) {
  throw new Error(`Shadcn dry run escaped the web source tree:\n${report}`);
}

process.stdout.write("shadcn output integrity clean: src/ui/components/button.tsx\n");
