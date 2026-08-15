import { describe, expect, it } from "vitest";
import { uploadedVersionId } from "./cloudflare-version";

const versionId = "123e4567-e89b-42d3-a456-426614174000";

describe("Cloudflare version upload output", () => {
  it("returns the one exact uploaded Worker version ID", () => {
    expect(uploadedVersionId(`Uploaded fidy-web\nWorker Version ID: ${versionId}\n`)).toBe(
      versionId
    );
  });

  it("rejects missing or ambiguous version identities", () => {
    expect(() => uploadedVersionId("Uploaded fidy-web")).toThrow("exactly one Worker version ID");
    expect(() =>
      uploadedVersionId(`Worker Version ID: ${versionId}\nWorker Version ID: ${versionId}\n`)
    ).toThrow("exactly one Worker version ID");
  });
});
