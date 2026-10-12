#!/usr/bin/env bun

import { Schema } from "effect";

const ComponentsConfig = Schema.Struct({
  aliases: Schema.Struct({
    components: Schema.String,
    ui: Schema.String,
    utils: Schema.String,
  }),
});
const TypeScriptConfig = Schema.Struct({
  compilerOptions: Schema.Struct({
    paths: Schema.Struct({
      "@/*": Schema.Tuple([Schema.Literal("./src/*")]),
    }),
  }),
});

const webRoot = Bun.fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const config = Schema.decodeUnknownSync(ComponentsConfig)(
  await Bun.file(`${webRoot}/components.json`).json()
);
const typeScriptConfig = Schema.decodeUnknownSync(TypeScriptConfig)(
  await Bun.file(`${webRoot}/tsconfig.json`).json()
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

const aliasTarget = typeScriptConfig.compilerOptions.paths["@/*"][0];
const resolveAlias = (alias: string): string =>
  `${aliasTarget.slice(0, -1)}${alias.slice(2)}`.replace(/^\.\//u, "");
const expectedPrimitivePath = "src/ui/components/button.tsx";
const resolvedPrimitivePaths = [config.aliases.components, config.aliases.ui].map((alias) =>
  resolveAlias(`${alias}/button.tsx`)
);
if (resolvedPrimitivePaths.some((path) => path !== expectedPrimitivePath)) {
  throw new Error(
    `Shadcn primitive aliases must resolve to ${expectedPrimitivePath}: ${resolvedPrimitivePaths.join(", ")}`
  );
}
if (resolveAlias(config.aliases.utils) !== "src/ui/class-names") {
  throw new Error("Shadcn utility alias must resolve to src/ui/class-names");
}

process.stdout.write(`shadcn output integrity clean: ${expectedPrimitivePath}\n`);
