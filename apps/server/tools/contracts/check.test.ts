import { Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { expect, it } from "vitest";
import { authorizeRemoval, readProductionWebRelease, rejectStaleAcknowledgement } from "./check";
import type { ContractFinding, ProductionWebRelease } from "./compatibility";

const validRelease = {
  contractDigest: "b".repeat(64),
  gitRevision: "a".repeat(40),
};
const finding: ContractFinding = {
  source: "openapi",
  rule: "api-operation-removed",
  location: {},
  detail: "removed POST /widgets",
};
const acknowledgement = {
  baseDigest: validRelease.contractDigest,
  candidateDigest: "c".repeat(64),
  findings: [finding],
  rolloutIssue: "https://github.com/B4rz99/fidy-ai/issues/999",
};

const clientReturning = (response: Response): HttpClient.HttpClient =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response)));

const readWith = (
  client: HttpClient.HttpClient,
  options?: Parameters<typeof readProductionWebRelease>[0]
): Promise<ProductionWebRelease> =>
  readProductionWebRelease(options).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.runPromise
  );

it("reads valid Production release evidence through the HTTP boundary", async () => {
  await expect(readWith(clientReturning(Response.json(validRelease)))).resolves.toEqual(
    validRelease
  );
});

it("rejects a non-success Production metadata response", async () => {
  await expect(readWith(clientReturning(new Response(null, { status: 503 })))).rejects.toThrow(
    "HTTP 503"
  );
});

it("stops reading Production evidence as soon as its byte limit is exceeded", async () => {
  let pullCount = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller): void {
      pullCount += 1;
      controller.enqueue(new TextEncoder().encode("12345"));
    },
  });

  await expect(readWith(clientReturning(new Response(body)), { maximumBytes: 4 })).rejects.toThrow(
    "exceeds 4 bytes"
  );
  expect(pullCount).toBe(1);
});

it("rejects malformed Production release evidence", async () => {
  await expect(
    readWith(clientReturning(Response.json({ gitRevision: "not-a-revision" })))
  ).rejects.toThrow("not a valid release identity");
});

it("times out Production evidence requests that do not return", async () => {
  const client = HttpClient.make(() => Effect.never);

  const error: unknown = await readWith(client, { timeout: "1 millis" }).catch(
    (cause: unknown) => cause
  );
  expect(error).toMatchObject({ _tag: "TimeoutError" });
});

it("rejects an acknowledgement left behind after findings disappear", () => {
  expect(() =>
    rejectStaleAcknowledgement({
      acknowledgement,
      findings: [],
      path: "acknowledgement.json",
    })
  ).toThrow("Delete stale acknowledgement.json");
});

it("authorizes exact final removal through the Git and deployment seams", async () => {
  const output: Array<string> = [];
  const commands: Array<ReadonlyArray<string>> = [];

  await expect(
    authorizeRemoval(
      {
        acknowledgement,
        baseRef: "origin/trunk",
        baseDigest: acknowledgement.baseDigest,
        candidateDigest: acknowledgement.candidateDigest,
        findings: [finding],
      },
      {
        runCommand: (command) => {
          commands.push(command);
          return command[1] === "rev-parse"
            ? { exitCode: 0, stdout: `${validRelease.gitRevision}\n`, stderr: "" }
            : { exitCode: 0, stdout: "", stderr: "" };
        },
        readDeployedWeb: async () => validRelease,
        writeOutput: (message) => output.push(message),
      }
    )
  ).resolves.toBe(true);
  expect(commands).toEqual([
    ["git", "rev-parse", "origin/trunk^{commit}"],
    ["git", "diff", "--quiet", "origin/trunk", "--", "apps/web"],
  ]);
  expect(output).toEqual([expect.stringContaining("final-removal")]);
});

it("authorizes an exact acknowledged break adopted by the candidate web", async () => {
  let deploymentRead = false;
  const output: Array<string> = [];

  await expect(
    authorizeRemoval(
      {
        acknowledgement,
        baseRef: "origin/trunk",
        baseDigest: acknowledgement.baseDigest,
        candidateDigest: acknowledgement.candidateDigest,
        findings: [finding],
      },
      {
        runCommand: (command) =>
          command[1] === "rev-parse"
            ? { exitCode: 0, stdout: `${validRelease.gitRevision}\n`, stderr: "" }
            : { exitCode: 1, stdout: "", stderr: "" },
        readDeployedWeb: async () => {
          deploymentRead = true;
          return validRelease;
        },
        writeOutput: (message) => output.push(message),
      }
    )
  ).resolves.toBe(true);
  expect(deploymentRead).toBe(false);
  expect(output).toEqual([expect.stringContaining("initial-breaking")]);
});
