import { extname } from "node:path";
import { Schema } from "effect";
import { ReleaseMetadata } from "../../scripts/release-metadata";

const REQUIRED_PATHS = new Set(["_headers", "deployment-metadata.json", "index.html"]);
const ASSET_SUFFIXES = new Set([
  ".avif",
  ".css",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".otf",
  ".png",
  ".svg",
  ".ttf",
  ".webp",
  ".woff",
  ".woff2",
]);
const FORBIDDEN_CONTENT = [
  "BEGIN PRIVATE KEY",
  "CLOUDFLARE_API_TOKEN",
  "DATABASE_URL",
  "MIGRATION_DATABASE_URL",
  "RAILWAY_API_TOKEN",
  "/apps/server/src/",
  "node_modules/@effect/sql-pg",
];

export type ProductionArtifactRequest = {
  readonly directory: string;
  readonly expectedSha: string;
  readonly expectedDigest: string;
};

const allowedPath = (path: string): boolean =>
  REQUIRED_PATHS.has(path) ||
  (path.startsWith("assets/") && ASSET_SUFFIXES.has(extname(path).toLowerCase()));

const validatePath = (path: string): void => {
  const parts = path.toLowerCase().split("/");
  const serverShaped = parts.some((part) => part.includes("server") || part.includes("worker"));
  if (!allowedPath(path) || path.endsWith(".map") || serverShaped) {
    throw new Error(`forbidden production artifact path: ${path}`);
  }
};

const validateContents = (directory: string, path: string): Promise<void> =>
  Bun.file(`${directory}/${path}`)
    .text()
    .then((contents) => {
      if (FORBIDDEN_CONTENT.some((marker) => contents.includes(marker))) {
        throw new Error(`forbidden server or Secret material in production artifact: ${path}`);
      }
      if (contents.toLowerCase().includes("sourcemappingurl=")) {
        throw new Error(`forbidden source-map material in production artifact: ${path}`);
      }
    });

/**
 * Verifies the complete Production upload tree and its release identity before Cloudflare receives
 * it. The accepted tree is static-only and cannot contain source maps, server-shaped paths, or
 * known Secret material.
 */
export const validateProductionArtifact = async (
  request: ProductionArtifactRequest
): Promise<void> => {
  const paths = Array.from(
    new Bun.Glob("**/*").scanSync({
      cwd: request.directory,
      followSymlinks: false,
      onlyFiles: true,
    })
  ).sort();
  const missing = [...REQUIRED_PATHS].filter((path) => !paths.includes(path));
  if (missing.length > 0) {
    throw new Error(`production artifact is missing required files: ${missing.join(", ")}`);
  }

  paths.forEach(validatePath);
  await Promise.all(paths.map((path) => validateContents(request.directory, path)));

  const metadata = Schema.decodeUnknownSync(ReleaseMetadata)(
    await Bun.file(`${request.directory}/deployment-metadata.json`).json()
  );
  if (
    metadata.gitRevision !== request.expectedSha ||
    metadata.contractDigest !== request.expectedDigest
  ) {
    throw new Error("production artifact release identity does not match");
  }
};
