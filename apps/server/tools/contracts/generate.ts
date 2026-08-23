#!/usr/bin/env bun

import { OpenApi } from "effect/unstable/httpapi";
import { FidyApi, operationCatalog } from "~/shell/api";
import { publishOperationAccess } from "~/shell/_shared/operation-policy";
import {
  type ContractArtifacts,
  type JsonValue,
  type OperationPolicyManifest,
  asJsonObject,
  asJsonValue,
  contractDigest,
} from "./compatibility";

const serverRoot = Bun.fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/u, "");
const defaultOutputDirectory = `${serverRoot}/contracts`;

export const makeContractArtifacts = (): ContractArtifacts => ({
  openapi: asJsonObject(OpenApi.fromApi(FidyApi)),
  operationPolicy: {
    operations: operationCatalog.operations
      .map(({ id, policy }) => ({
        id,
        policy: asJsonValue({
          access: publishOperationAccess(policy.access),
          requiredTier: policy.requiredTier,
          agentConfirmation: policy.agentConfirmation,
          kind: policy.kind,
        }),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  },
});

const artifactText = (value: JsonValue | OperationPolicyManifest): string =>
  `${JSON.stringify(asJsonValue(value), null, 2)}\n`;

type ContractArtifactFile = {
  readonly name: string;
  readonly contents: string;
};

const artifactFiles = (artifacts: ContractArtifacts): ReadonlyArray<ContractArtifactFile> => [
  { name: "openapi.json", contents: artifactText(artifacts.openapi) },
  { name: "operation-policy.json", contents: artifactText(artifacts.operationPolicy) },
];

const parseArguments = (
  arguments_: ReadonlyArray<string>
): { readonly check: boolean; readonly outputDirectory: string } => {
  let check = false;
  let outputDirectory = defaultOutputDirectory;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--check") {
      check = true;
    } else if (argument === "--output-dir") {
      const value = arguments_[index + 1];
      if (value === undefined) throw new Error("--output-dir requires a path");
      outputDirectory = value;
      index += 1;
    } else {
      throw new Error(`Unknown contract generation argument: ${argument}`);
    }
  }
  return { check, outputDirectory };
};

const main = async (): Promise<void> => {
  const { check, outputDirectory } = parseArguments(Bun.argv.slice(2));
  const artifacts = makeContractArtifacts();
  const stale: Array<string> = [];

  await Promise.all(
    artifactFiles(artifacts).map(async ({ name, contents }) => {
      const path = `${outputDirectory}/${name}`;
      if (check) {
        const file = Bun.file(path);
        if (!(await file.exists()) || (await file.text()) !== contents) stale.push(path);
      } else {
        await Bun.write(path, contents, { createPath: true });
      }
    })
  );

  if (stale.length > 0) {
    throw new Error(
      `Generated server contracts are stale:\n${stale.map((path) => `  - ${path}`).join("\n")}\nRun \`bun run contracts:generate\`.`
    );
  }
  process.stdout.write(
    `${check ? "fresh" : "generated"} server contracts (${contractDigest(artifacts)})\n`
  );
};

if (import.meta.main) await main();
