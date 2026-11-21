import { createRequire } from "node:module";
import { AstroCheck } from "@astrojs/language-server";

const require = createRequire(import.meta.url);

const target = process.argv[2] ?? "../../apps/site";

const root = Bun.fileURLToPath(new URL(target, import.meta.url));

const checker = new AstroCheck(root, require.resolve("typescript"), `${root}/tsconfig.json`);

const result = await checker.lint({ logErrors: { level: "warning" } });

process.stdout.write(`Astro diagnostics: ${result.errors} errors, ${result.warnings} warnings.\n`);

if (result.errors > 0 || result.warnings > 0) process.exitCode = 1;
