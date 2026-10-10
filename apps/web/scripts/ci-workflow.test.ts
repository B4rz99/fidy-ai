import { describe, expect, it } from "vitest";

const repositoryRoot = `${process.cwd()}/../..`;
const checksWorkflow = await Bun.file(`${repositoryRoot}/.github/workflows/ci.yml`).text();
const bunInstallAction = await Bun.file(
  `${repositoryRoot}/.github/actions/bun-install/action.yml`
).text();
const candidateWorkflow = await Bun.file(
  `${repositoryRoot}/.github/workflows/cli-release-build.yml`
).text();
const publisherWorkflow = await Bun.file(
  `${repositoryRoot}/.github/workflows/cli-release-publish.yml`
).text();

describe("pull-request checks workflow policy", () => {
  it("builds the application without uploading or deploying a PR preview artifact", () => {
    const buildsJob = checksWorkflow.slice(
      checksWorkflow.indexOf("\n  builds:\n"),
      checksWorkflow.indexOf("\n  unit:\n")
    );

    expect(buildsJob).toContain("bun run verify -- --group builds");
    expect(buildsJob).not.toContain("upload-artifact");
    expect(checksWorkflow).not.toContain("build:preview");
    return Bun.file(`${repositoryRoot}/.github/workflows/preview.yml`)
      .exists()
      .then((exists) => expect(exists).toBe(false));
  });

  it("keeps the required checks focused on static and browser validation", () => {
    expect(checksWorkflow).not.toContain("server-runtime:");
    expect(checksWorkflow).not.toContain("database-runtime:");
    expect(checksWorkflow).not.toContain("container-image:");
    expect(checksWorkflow).toContain("Web browser and accessibility checks");
  });

  it("reuses browser downloads without restoring stale dependency caches", () => {
    const browserJob = checksWorkflow.slice(
      checksWorkflow.indexOf("\n  browser:\n"),
      checksWorkflow.indexOf("\n  security-secrets:\n")
    );

    expect(browserJob).toContain("~/.cache/ms-playwright");
    const restore = browserJob.indexOf("actions/cache@");
    const systemDependencies = browserJob.indexOf("playwright install-deps chromium");
    const binaries = browserJob.indexOf("playwright install --only-shell chromium");
    expect(restore).toBeGreaterThan(0);
    expect(systemDependencies).toBeGreaterThan(restore);
    expect(binaries).toBeGreaterThan(systemDependencies);
    expect(browserJob).toContain(
      "${{ runner.os }}-${{ runner.arch }}-playwright-${{ steps.playwright-version.outputs.version }}-headless-shell"
    );
    const installation = browserJob.slice(
      browserJob.indexOf("- name: Install Chromium system dependencies"),
      browserJob.indexOf("- name: Static-shell browser validation")
    );
    // Both system dependencies and missing binaries must be repaired on warm caches too.
    expect(installation).not.toContain("if:");
    expect(bunInstallAction).not.toContain("restore-keys:");
  });

  it("keeps the merge gate unconditional and checks skipped jobs against a successful plan", () => {
    const requiredJob = checksWorkflow.slice(checksWorkflow.indexOf("\n  required-checks:\n"));
    expect(requiredJob).toContain("name: Required Checks");
    expect(requiredJob).toContain("- changes");
    expect(requiredJob).toContain("if: ${{ always() }}");
    expect(checksWorkflow).toContain("required-script: ${{ steps.results-gate.outputs.script }}");
    expect(checksWorkflow).toContain("cat scripts/check-ci-results.sh");
    expect(requiredJob).toContain(
      "REQUIRED_CHECK_SCRIPT: ${{ needs.changes.outputs.required-script }}"
    );
    expect(requiredJob).toContain("${REQUIRED_CHECK_SCRIPT:?Required-check script unavailable}");
    expect(requiredJob).toContain('bash -c "$REQUIRED_CHECK_SCRIPT"');
    expect(checksWorkflow).toContain("fetch-depth: 0");
    expect(checksWorkflow).toContain("bun scripts/ci-changes.ts");
  });

  it("reuses every existing check for a pinned release while retaining PR diff selection", () => {
    expect(checksWorkflow).toContain("workflow_call:");
    expect(checksWorkflow).toContain("checks_passed: ${{ steps.gate.outputs.checks_passed }}");
    expect(checksWorkflow).toContain('[[ "$GITHUB_REF" == refs/heads/trunk');
    expect(checksWorkflow).toContain('"$(git rev-parse HEAD)" == "$EXPECTED_SHA"');
    expect(checksWorkflow).toContain('if [[ "$GITHUB_EVENT_NAME" == pull_request ]]; then');
    expect(checksWorkflow).toContain("bun scripts/ci-changes.ts --all");
    expect(checksWorkflow).toContain("|| 'HEAD^' }}");
    const baseFetch = checksWorkflow.slice(
      checksWorkflow.indexOf("- name: Fetch base branch tip"),
      checksWorkflow.indexOf("# Oxlint's RuleTester")
    );
    // Fetching trunk at depth one during a release would hide the HEAD^ migration base.
    expect(baseFetch).toContain("if: ${{ github.event_name == 'pull_request' }}");
    const requiredJob = checksWorkflow.slice(checksWorkflow.indexOf("\n  required-checks:\n"));
    expect(requiredJob.indexOf("echo 'checks_passed=true'")).toBeGreaterThan(
      requiredJob.indexOf('bash -c "$REQUIRED_CHECK_SCRIPT"')
    );
    expect(checksWorkflow).not.toContain("secrets: inherit");
    expect(checksWorkflow).not.toContain("contents: write");
  });

  it("runs native conformance from a same-run bundle without installing platform workspace dependencies", () => {
    const packageJob = checksWorkflow.slice(
      checksWorkflow.indexOf("\n  cli-native-package:\n"),
      checksWorkflow.indexOf("\n  cli-native:\n")
    );
    const nativeJob = checksWorkflow.slice(
      checksWorkflow.indexOf("\n  cli-native:\n"),
      checksWorkflow.indexOf("\n  required-checks:\n")
    );
    const requiredJob = checksWorkflow.slice(checksWorkflow.indexOf("\n  required-checks:\n"));

    expect(packageJob).toContain("runs-on: ubuntu-latest");
    expect(packageJob).toContain("bun run --cwd apps/cli build:native");
    expect(packageJob).toContain("if-no-files-found: error");
    expect(nativeJob).toContain("needs: [changes, cli-native-package]");
    expect(nativeJob).toContain("./.github/actions/bun-runtime");
    expect(nativeJob).toContain("actions/download-artifact@");
    expect(nativeJob).toContain("bun test-results/cli-native/native-store.js");
    expect(nativeJob).not.toContain("bun-install");
    expect(nativeJob).not.toContain("run-id:");
    expect(nativeJob).not.toContain("repository:");
    expect(requiredJob).toContain("- cli-native-package");
    expect(checksWorkflow).toContain("cli-native-package: ${{ steps.plan.outputs.unit }}");
  });

  it("keeps PR native fixtures ephemeral and requires reviewed evidence before candidate upload", () => {
    expect(candidateWorkflow).not.toContain("contents: write");
    expect(candidateWorkflow).toContain('"$GITHUB_EVENT_NAME" == workflow_dispatch');
    expect(candidateWorkflow).toContain('"$GITHUB_REPOSITORY" == B4rz99/fidy-ai');
    expect(candidateWorkflow).toContain('"$(git rev-parse HEAD)" == "$EXPECTED_SHA"');
    expect(candidateWorkflow).toContain(
      "distributable: ${{ steps.materials.outputs.distributable }}"
    );
    expect(candidateWorkflow).not.toContain("inputs.version ||");
    const smoke = candidateWorkflow.slice(
      candidateWorkflow.indexOf("- name: Test native executable"),
      candidateWorkflow.indexOf("- name: Test publisher")
    );
    expect(smoke).toContain("if: ${{ needs.source.outputs.distributable != 'true' }}");
    expect(smoke).toContain("python3 scripts/cli-release/test-native.py");
    const upload = candidateWorkflow.slice(
      candidateWorkflow.indexOf("- name: Preserve candidate archives"),
      candidateWorkflow.indexOf("\n  candidate-gate:")
    );
    expect(upload).toContain("if: ${{ needs.source.outputs.distributable == 'true' }}");
    expect(upload).toContain("dist/cli-release/*.zip");
    expect(upload).not.toContain("RUNNER_TEMP");
    const gate = candidateWorkflow.slice(candidateWorkflow.indexOf("\n  candidate-gate:"));
    expect(gate).toContain('[[ "$SOURCE_RESULT" == success && "$PACKAGES_RESULT" == success ]]');
    expect(gate).toContain('if [[ "$DISTRIBUTABLE" == true ]]; then');
    expect(publisherWorkflow).toContain("needs.candidates.outputs.candidates_passed == 'true'");
    expect(publisherWorkflow).toContain("needs.checks.outputs.checks_passed == 'true'");
    expect(publisherWorkflow).toContain("merge-multiple: false");
    expect(publisherWorkflow).not.toContain("secrets: inherit");
    expect(publisherWorkflow.match(/contents: write/gu)).toHaveLength(1);
  });

  it("runs mutation testing weekly on Sundays without blocking pull requests", () => {
    expect(checksWorkflow).not.toContain("test:mutation");
    return Bun.file(`${repositoryRoot}/.github/workflows/mutation.yml`)
      .text()
      .then((workflow) => {
        expect(workflow).toContain('cron: "17 5 * * 0"');
        expect(workflow).toContain("workflow_dispatch:");
        expect(workflow).not.toContain("pull_request:");
        expect(workflow).toContain("run: bun run test:mutation");
      });
  });

  it("pins every external Action to a complete commit SHA", () => {
    const externalActions = Array.from(
      checksWorkflow.matchAll(/^\s+(?:- )?uses: ([^./][^@\s]+)@([^\s#]+)/gmu)
    );

    expect(externalActions.length).toBeGreaterThan(0);
    for (const action of externalActions) expect(action[2]).toMatch(/^[0-9a-f]{40}$/u);
  });
});
