import { dashboardAssessmentSurface } from "../../server/cloudflare/browser-acceptance/operations";
import { Effect, Schema, Struct } from "effect";
import { type DashboardAssessmentConfiguration } from "../../server/cloudflare/browser-acceptance/contract";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const hashReader = Effect.fn(function* (reader: ReadableStreamDefaultReader<Uint8Array>) {
  const hash = new Bun.CryptoHasher("sha256");
  for (;;) {
    const part = yield* Effect.tryPromise(() => reader.read());
    if (part.done) break;
    hash.update(part.value);
  }
  return hash.digest("hex");
});
const browserDigest = Effect.fn(function* () {
  const path = Bun.env.ASSESSMENT_CHROMIUM;
  if (path === undefined) return "unavailable";
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => Bun.file(path).stream().getReader()),
    hashReader,
    (reader) => Effect.tryPromise(() => reader.cancel()).pipe(Effect.ignore)
  );
});
const hashFiles = Effect.fn(function* (base: URL, names: ReadonlyArray<string>) {
  const hash = new Bun.CryptoHasher("sha256");
  for (const name of names) {
    const contents = yield* Effect.tryPromise(() => Bun.file(new URL(name, base)).text());
    hash.update(name).update("\0").update(contents).update("\0");
  }
  return hash.digest("hex");
});

const sourceProvenance = (): Readonly<{
  revision: string;
  sourceClean: boolean;
  requestedRevisionMatches: boolean;
}> => {
  const cwd = new URL("../../../", import.meta.url).pathname;
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd });
  const revision = new TextDecoder().decode(head.stdout).trim();
  if (head.exitCode !== 0 || !/^[a-f0-9]{40}$/u.test(revision)) {
    throw new Error("Assessment source revision is unavailable");
  }
  const changed = Bun.spawnSync(["git", "diff", "--quiet", "HEAD", "--"], { cwd });
  const untracked = Bun.spawnSync(["git", "ls-files", "--others", "--exclude-standard"], { cwd });
  return {
    revision,
    sourceClean:
      changed.exitCode === 0 && untracked.exitCode === 0 && untracked.stdout.byteLength === 0,
    requestedRevisionMatches:
      Bun.env.FIDY_ASSESSMENT_REVISION === undefined ||
      Bun.env.FIDY_ASSESSMENT_REVISION === revision,
  };
};

const adapterFiles = [
  "apps/web/scripts/serve-preview.ts",
  "apps/web/playwright.config.ts",
  "apps/server/cloudflare/browser-acceptance-preview.ts",
  "apps/server/cloudflare/browser-acceptance-seed.ts",
  "apps/server/cloudflare/d1-test-fixture.ts",
];

/** Pins observation code separately from target behavior. Both revisions must copy identical fixture/harness files. */
export const dashboardAssessmentProvenance = Effect.fn(function* (
  input: Readonly<{
    configuration: typeof DashboardAssessmentConfiguration.Encoded;
    layoutDigest: string;
  }>
) {
  const harnessDigest = yield* hashFiles(new URL("../", import.meta.url), [
    "e2e/dashboard.assessment.ts",
    "e2e/dashboard-assessment-workload.ts",
    "e2e/dashboard-assessment-provenance.ts",
    "e2e/dashboard-measurement.ts",
    "e2e/assessment-fixture.ts",
    "e2e/real-core-fixture.ts",
    "e2e/acceptance-clock.ts",
    "e2e/playwright-runtime.ts",
    "playwright.assessment.config.ts",
  ]);
  const builderDigest = yield* hashFiles(new URL("../../server/cloudflare/", import.meta.url), [
    "browser-assessment.test-fixture.ts",
    "browser-assessment-layout.test-fixture.ts",
    "browser-assessment-prepare.test-fixture.ts",
    "browser-acceptance-clock.test-fixture.ts",
    "browser-acceptance/contract.ts",
    "browser-acceptance/operations.ts",
  ]);
  const adapterDigest = yield* hashFiles(new URL("../../../", import.meta.url), adapterFiles);
  const dependenciesDigest = yield* hashFiles(new URL("../../../", import.meta.url), [
    "bun.lock",
    "package.json",
    "apps/web/package.json",
    "apps/server/package.json",
    "apps/web/vite.config.ts",
  ]);
  return {
    ...sourceProvenance(),
    harnessDigest,
    adapterDigest,
    surface: dashboardAssessmentSurface(),
    trafficSource: "shared-loopback" as const,
    dependenciesDigest,
    fixtureDigest: new Bun.CryptoHasher("sha256")
      .update(
        json({
          builderDigest,
          configuration: Struct.omit(input.configuration, ["backend"]),
          layoutDigest: input.layoutDigest,
        })
      )
      .digest("hex"),
    browserDigest: yield* browserDigest(),
    runtime: `Bun ${Bun.version}`,
    compression: Bun.env.PREVIEW_COMPRESSION ?? "identity",
    build: Bun.env.FIDY_ASSESSMENT_BUILD ?? "production",
  };
});
