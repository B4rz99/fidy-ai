#!/usr/bin/env bun

import { type Cause, Effect, Option, type SchemaAST, type SchemaRepresentation } from "effect";
import { OpenApi } from "effect/unstable/httpapi";
import { FidyApi, operationCatalog } from "../../src/shell/api";
import { PATPairingApi } from "../../src/shell/tokens/contract";
import { publishOperationAccess } from "../../src/shell/canonical-policy/contract";
import {
  type ContractArtifacts,
  type JsonValue,
  type OperationPolicyManifest,
  asJsonObject,
  asJsonValue,
  contractDigest,
} from "./artifacts";

const serverRoot = Bun.fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/u, "");
const defaultOutputDirectory = `${serverRoot}/contracts`;

const literalReferenceCostScale = 32;

const isWorthReferencing = (bodyCost: number, occurrences: number): boolean =>
  occurrences * bodyCost > bodyCost + occurrences + 1;

const hasShareableStructure = (ast: SchemaAST.AST): boolean => {
  if (
    ast._tag === "Arrays" ||
    ast._tag === "Objects" ||
    ast._tag === "Suspend" ||
    ast._tag === "Declaration"
  ) {
    return true;
  }
  return ast._tag === "Union" && ast.types.some(hasShareableStructure);
};

const inlineReferenceCost = (ast: SchemaAST.AST): Option.Option<number> => {
  if (ast._tag === "Union") return Option.some(ast.types.length + 1);
  if (ast._tag === "Enum") return Option.some(ast.enums.length + 1);
  if (ast._tag === "TemplateLiteral") return Option.some(ast.parts.length + 1);
  if (ast._tag === "Literal" && typeof ast.literal === "string") {
    return Option.some(ast.literal.length / literalReferenceCostScale + 1);
  }
  return Option.none();
};

const contractReferencePolicy = ({
  ast,
  identifier,
  occurrences,
}: {
  readonly ast: SchemaAST.AST;
  readonly identifier: Option.Option<string>;
  readonly occurrences: number;
}): Option.Option<string> => {
  if (Option.isSome(identifier)) return identifier;
  if (occurrences <= 1) return Option.none();
  if (hasShareableStructure(ast)) return Option.some(`${ast._tag}_`);

  const cost = inlineReferenceCost(ast);
  return Option.isSome(cost) && isWorthReferencing(cost.value, occurrences)
    ? Option.some(`${ast._tag}_`)
    : Option.none();
};

// SchemaRepresentation's foreign policy uses undefined for inline candidates, not JSON null.
const openApiReferencePolicy = ({
  ast,
  identifier,
  occurrences,
}: SchemaRepresentation.ReferencePolicyInput): ReturnType<SchemaRepresentation.ReferencePolicy> =>
  Option.getOrUndefined(
    contractReferencePolicy({ ast, identifier: Option.fromUndefinedOr(identifier), occurrences })
  );

export const makeContractArtifacts = (): ContractArtifacts => ({
  openapi: asJsonObject({
    value: OpenApi.fromApi(FidyApi, { referencePolicy: openApiReferencePolicy }),
  }),
  operationPolicy: {
    operations: operationCatalog.operations
      .map(({ id, policy }) => ({
        id,
        policy: asJsonValue({
          value: {
            access: publishOperationAccess(policy.access),
            requiredTier: policy.requiredTier,
            agentConfirmation: policy.agentConfirmation,
            kind: policy.kind,
          },
        }),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  },
});

const artifactText = (value: JsonValue | OperationPolicyManifest): string =>
  `${JSON.stringify(asJsonValue({ value }), null, 2)}\n`;

type ContractArtifactFile = {
  readonly name: string;
  readonly contents: string;
};

const artifactFiles = (artifacts: ContractArtifacts): ReadonlyArray<ContractArtifactFile> => [
  { name: "openapi.json", contents: artifactText(artifacts.openapi) },
  {
    name: "pat-pairing-openapi.json",
    contents: artifactText(
      asJsonObject({
        value: OpenApi.fromApi(PATPairingApi, { referencePolicy: openApiReferencePolicy }),
      })
    ),
  },
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

const checkArtifact = (
  { name, contents }: ContractArtifactFile,
  outputDirectory: string,
  check: boolean
): Effect.Effect<boolean, Cause.UnknownError> => {
  const path = `${outputDirectory}/${name}`;
  if (!check) {
    return Effect.tryPromise(() => Bun.write(path, contents, { createPath: true })).pipe(
      Effect.as(false)
    );
  }
  const file = Bun.file(path);
  return Effect.gen(function* () {
    if (!(yield* Effect.tryPromise(() => file.exists()))) return true;
    return (yield* Effect.tryPromise(() => file.text())) !== contents;
  });
};

const main = Effect.gen(function* () {
  const { check, outputDirectory } = parseArguments(Bun.argv.slice(2));
  const artifacts = makeContractArtifacts();
  const files = artifactFiles(artifacts);
  const stale = yield* Effect.forEach(
    files,
    (file) => checkArtifact(file, outputDirectory, check),
    { concurrency: "unbounded" }
  );
  const stalePaths = files
    .filter((_, index) => stale[index])
    .map(({ name }) => `${outputDirectory}/${name}`);
  if (stalePaths.length > 0) {
    throw new Error(
      `Generated server contracts are stale:\n${stalePaths.map((path) => `  - ${path}`).join("\n")}\nRun \`bun run contracts:generate\`.`
    );
  }
  process.stdout.write(
    `${check ? "fresh" : "generated"} server contracts (${contractDigest(artifacts)})\n`
  );
});

if (import.meta.main) await Effect.runPromise(main);
