import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const artifactRoot = "dist";
const sentryEndpoint = "https://sentry.io/";
const commandTimeoutMilliseconds = 12_000;
const uploadWaitSeconds = "8";
const maximumAttempts = 3;
const retryDelayMilliseconds = 250;
const fullShaPattern = /^[0-9a-f]{40}$/u;
const debugIdPattern = /^[0-9a-f]{32}$/u;

type ReleaseConfiguration = Readonly<{
  authToken: string;
  organization: string;
  project: string;
  release: string;
}>;

type SentryOperation = Readonly<{
  arguments: ReadonlyArray<string>;
  failureGuidance: string;
  label: string;
}>;

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required for Sentry release preparation.`);
  }
  return value;
};

const releaseConfiguration = (): ReleaseConfiguration => {
  const commitSha = requiredEnvironment("RAILWAY_GIT_COMMIT_SHA");
  if (!fullShaPattern.test(commitSha)) {
    throw new Error("RAILWAY_GIT_COMMIT_SHA must be a full lowercase Git commit SHA.");
  }
  const release = `fidy@${commitSha}`;
  const configuredRelease = process.env.SENTRY_RELEASE?.trim();
  if (
    configuredRelease !== undefined &&
    configuredRelease.length > 0 &&
    configuredRelease !== release
  ) {
    throw new Error("SENTRY_RELEASE must equal fidy@ plus RAILWAY_GIT_COMMIT_SHA when provided.");
  }
  return {
    authToken: requiredEnvironment("SENTRY_AUTH_TOKEN"),
    organization: requiredEnvironment("SENTRY_ORG"),
    project: requiredEnvironment("SENTRY_PROJECT"),
    release,
  };
};

const normalizedDebugId = (value: string): string => value.replaceAll("-", "").toLowerCase();

const javascriptDebugId = (source: string, path: string): string => {
  const matches = Array.from(source.matchAll(/\/\/# debugId=([A-Fa-f0-9-]+)/gu));
  const candidate = matches.at(-1)?.[1];
  if (candidate === undefined || !debugIdPattern.test(normalizedDebugId(candidate))) {
    throw new Error(`Missing or malformed JavaScript debug ID in ${path}.`);
  }
  return normalizedDebugId(candidate);
};

const decodedSourceMap = (source: string, path: string): object => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(source);
  } catch {
    throw new Error(`Malformed source map JSON in ${path}.`);
  }
  if (typeof decoded !== "object" || decoded === null) {
    throw new Error(`Missing source map debug ID in ${path}.`);
  }
  return decoded;
};

const mapDebugId = (source: string, path: string): string => {
  const decoded = decodedSourceMap(source, path);
  const embeddedDebugId = "debugId" in decoded ? decoded.debugId : undefined;
  const candidate = embeddedDebugId ?? ("debug_id" in decoded ? decoded.debug_id : undefined);
  if (typeof candidate !== "string" || !debugIdPattern.test(normalizedDebugId(candidate))) {
    throw new Error(`Missing or malformed source map debug ID in ${path}.`);
  }
  return normalizedDebugId(candidate);
};

const validateArtifacts = async (): Promise<void> => {
  const paths = await readdir(artifactRoot, { recursive: true });
  const javascriptPaths = paths.filter((path) => path.endsWith(".js")).sort();
  if (javascriptPaths.length === 0) {
    throw new Error("No built JavaScript artifacts were found in dist.");
  }
  await Promise.all(
    javascriptPaths.map(async (relativePath) => {
      const javascriptPath = join(artifactRoot, relativePath);
      const sourceMapPath = `${javascriptPath}.map`;
      let javascript: string;
      let sourceMap: string;
      try {
        [javascript, sourceMap] = await Promise.all([
          readFile(javascriptPath, "utf8"),
          readFile(sourceMapPath, "utf8"),
        ]);
      } catch {
        throw new Error(`Missing JavaScript or source map artifact for ${javascriptPath}.`);
      }
      if (javascriptDebugId(javascript, javascriptPath) !== mapDebugId(sourceMap, sourceMapPath)) {
        throw new Error(`JavaScript and source map debug IDs differ for ${javascriptPath}.`);
      }
    })
  );
};

const runCliAttempt = async (
  arguments_: ReadonlyArray<string>,
  configuration: ReleaseConfiguration
): Promise<boolean> => {
  const child = Bun.spawn(
    [join(import.meta.dir, "sentry-cli"), "--url", sentryEndpoint, ...arguments_],
    {
      env: {
        SENTRY_AUTH_TOKEN: configuration.authToken,
        SENTRY_FORCE_ENV_TOKEN: "1",
        SENTRY_ORG: configuration.organization,
        SENTRY_PROJECT: configuration.project,
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }
  );
  const timeout = setTimeout(() => {
    child.kill();
  }, commandTimeoutMilliseconds);
  const exitCode = await child.exited;
  clearTimeout(timeout);
  return exitCode === 0;
};

const runRequiredAttempt = async (
  operation: SentryOperation,
  configuration: ReleaseConfiguration,
  attempt: number
): Promise<void> => {
  if (await runCliAttempt(operation.arguments, configuration)) return;
  if (attempt === maximumAttempts) {
    throw new Error(
      `Sentry ${operation.label} failed after ${maximumAttempts} attempts; ${operation.failureGuidance}.`
    );
  }
  await Bun.sleep(retryDelayMilliseconds * attempt);
  await runRequiredAttempt(operation, configuration, attempt + 1);
};

const runRequired = (
  operation: SentryOperation,
  configuration: ReleaseConfiguration
): Promise<void> => runRequiredAttempt(operation, configuration, 1);

/**
 * Publishes the exact built artifacts for the immutable Railway deployment release.
 * The caller must provide the required Railway and Sentry upload environment variables and run
 * from the image work directory containing `dist`. The returned release is finalized and safe to
 * reuse; invalid configuration, invalid artifact pairs, or exhausted Sentry attempts fail the call.
 */
export const prepareSentryRelease = async (): Promise<string> => {
  const configuration = releaseConfiguration();
  await validateArtifacts();

  await runRequired(
    {
      arguments: ["releases", "new", configuration.release],
      failureGuidance: "verify the org:ci token and organization access",
      label: "release creation",
    },
    configuration
  );
  await runRequired(
    {
      arguments: [
        "sourcemaps",
        "upload",
        "--release",
        configuration.release,
        "--validate",
        "--strict",
        "--wait-for",
        uploadWaitSeconds,
        artifactRoot,
      ],
      failureGuidance:
        "verify the org:ci token, project access, source-map upload entitlement, and Sentry availability",
      label: "source-map upload",
    },
    configuration
  );
  await runRequired(
    {
      arguments: ["releases", "finalize", configuration.release],
      failureGuidance: "verify the org:ci token and release access",
      label: "release finalization",
    },
    configuration
  );
  return configuration.release;
};
