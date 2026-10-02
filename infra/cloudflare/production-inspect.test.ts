import { describe, expect, it } from "vitest";

const workflow = await Bun.file("../../.github/workflows/production-inspect.yml").text();

describe("Production inspection policy", () => {
  it("keeps optional log inspection behind protected trunk credentials and deployment serialization", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("log_timestamp:");
    expect(workflow).toContain("required: false");
    expect(workflow).toContain("if: github.ref == 'refs/heads/trunk'");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("group: production-deployment");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("INSPECT_LOG_TIMESTAMP: ${{ inputs.log_timestamp }}");
    expect(workflow).toContain("run: bun production-release.ts inspect");
    expect(workflow).not.toMatch(
      /run:.*inputs\.log_timestamp|alchemy deploy|upload-artifact|wrangler (deploy|tail)/u
    );
  });
});
