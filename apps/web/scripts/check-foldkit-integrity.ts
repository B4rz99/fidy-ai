#!/usr/bin/env bun
import { Schema } from "effect";

const Manifest = Schema.Struct({
  dependencies: Schema.Record(Schema.String, Schema.String),
  devDependencies: Schema.Record(Schema.String, Schema.String),
});

const root = Bun.fileURLToPath(new URL("..", import.meta.url));
const manifest = Schema.decodeUnknownSync(Manifest)(await Bun.file(`${root}/package.json`).json());
const forbidden = /(?:^|[/@-])react(?:$|[/@-])|^shadcn$|^recharts$|^sonner$/u;
if (!Object.hasOwn(manifest.dependencies, "foldkit")) {
  throw new Error("The frontend must depend on Foldkit");
}
for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
  if (forbidden.test(dependency)) throw new Error(`Unsupported frontend dependency: ${dependency}`);
}
const paths = [...new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd: root })];
const sources = await Promise.all(paths.map((path) => Bun.file(`${root}/${path}`).text()));
for (const [index, path] of paths.entries()) {
  if (path.endsWith(".tsx")) throw new Error(`Native frontend source must use .ts: ${path}`);
  const source = sources[index] ?? "";
  if (/(?:from|import)\s*[('" ]+[\w@./-]*react(?:[/'"])/u.test(source)) {
    throw new Error(`Unsupported framework import: ${path}`);
  }
}
process.stdout.write("Foldkit source and dependency integrity clean\n");
