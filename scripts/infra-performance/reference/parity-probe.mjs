import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { BunServices } from "@effect/platform-bun";
import { Build, BuildProvider } from "../../node_modules/alchemy/lib/Command/Build.js";
import { CommandExecutorLive } from "../../node_modules/alchemy/lib/Command/Command.js";
import { Provider } from "../../node_modules/alchemy/lib/Provider.js";

const [checkout, contractDigest] = process.argv.slice(2);
const destination = path.join(process.env.RUNNER_TEMP, "web-parity");
const output = "../../apps/web/dist";
const props = { cwd: "../../apps/web", outdir: "dist", command: "bun run build:production",
  env: { CONTRACT_DIGEST: contractDigest, RELEASE_GIT_SHA: process.env.RETAINED } };
assert.match(contractDigest, /^[a-f0-9]{64}$/u);
const manifest = async () => {
  const files = {};
  for (const name of (await fs.readdir(output, { recursive: true })).sort()) {
    const entry = path.join(output, name);
    const stat = await fs.lstat(entry);
    if (stat.isDirectory()) continue;
    assert.ok(stat.isFile(), name);
    files[name] = { bytes: stat.size, sha256: createHash("sha256").update(await fs.readFile(entry)).digest("hex") };
  }
  return files;
};
const report = { checkout, bun: Bun.version, commit: Bun.spawnSync(["git","rev-parse","HEAD"]).stdout.toString().trim(), props, passes: [] };
assert.equal(report.commit, checkout === "original" ? process.env.RETAINED : process.env.REPAIR);
const previous = checkout === "candidate" ? JSON.parse(await fs.readFile(path.join(destination,"original.json"))).passes[0].receipt : undefined;
await Effect.runPromise(Effect.gen(function* () {
  const provider = yield* Provider(Build.Type);
  const session = { note: (line) => Effect.sync(() => console.log(line)) };
  let prior = previous;
  for (let i = 0; i < (checkout === "original" ? 1 : 2); ++i) {
    assert.equal(yield* Effect.promise(() => Bun.file(path.join(output,"index.html")).exists()), false);
    const absent = prior ? (yield* provider.diff({ olds: props, news: props, output: prior })).action : undefined;
    const receipt = yield* provider.reconcile({ news: props, session });
    const verdict = yield* provider.diff({ olds: props, news: props, output: previous ?? receipt });
    const files = yield* Effect.promise(manifest);
    const metadata = yield* Effect.promise(() => Bun.file(path.join(output,"deployment-metadata.json")).json());
    assert.deepEqual(metadata, {gitRevision: props.env.RELEASE_GIT_SHA, contractDigest});
    report.passes.push({ absent, receipt, afterAgainstOriginal: verdict.action, files, metadata });
    yield* Effect.promise(() => fs.writeFile(path.join(destination, checkout+".json"),JSON.stringify(report,null,2)));
    prior = receipt;
    if (checkout === "candidate" && i === 0) {
      yield* Effect.promise(() => fs.rename(output,path.join(process.env.RUNNER_TEMP,"candidate-first-dist")));
    }
  }
}).pipe(Effect.provide(BuildProvider()), Effect.provide(CommandExecutorLive()), Effect.provide(BunServices.layer), Effect.scoped));
