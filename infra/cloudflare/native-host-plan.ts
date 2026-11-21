import { isDeepStrictEqual } from "node:util";
import type { Plan } from "alchemy/Plan";
import { describePlan, describeResource } from "alchemy/Plan";
import { installedOrigins } from "@fidy/server/browser-transport";
import { Schema } from "effect";

const paths = {
  SupportRecoveryAccess: "/internal/support-recovery",
  TitularErasureAccess: "/internal/titular-erasure",
  BetaProAccess: "/internal/beta-pro",
  IngestSampleReviewAccess: "/internal/sample-review",
} as const;

export const stagedAccessApplications = Object.keys(paths);

const existingDependencies: ReadonlyMap<string, string> = new Map([
  ["RecoveryOperators", "Cloudflare.Access.Group"],
]);

const properties = Schema.Record(Schema.String, Schema.Unknown);

const pathFor = (id: string): string => {
  const found = Object.entries(paths).find(([name]) => name === id);

  if (found === undefined) throw Error("Unexpected host staging resource");

  return found[1];
};

export const requireStagedDestinations = ({
  logicalId,
  before,
  after,
}: {
  logicalId: string;
  before: unknown;
  after: unknown;
}): void => {
  const { destinations: old, ...previous } = Schema.decodeUnknownSync(properties)(before);
  const { destinations: next, ...desired } = Schema.decodeUnknownSync(properties)(after);

  const destinations = Object.values(installedOrigins).map((pair) => ({
    type: "public",
    uri: new URL(pair.api).hostname + pathFor(logicalId),
  }));

  if (
    !isDeepStrictEqual(previous, desired) ||
    !isDeepStrictEqual(next, destinations) ||
    !(isDeepStrictEqual(old, destinations.slice(0, 1)) || isDeepStrictEqual(old, destinations))
  ) {
    throw Error("Access change exceeds the reviewed canonical path");
  }
};

const requireStageNode = (node: Plan["resources"][string]): void => {
  const { logicalId, resourceType } = describeResource(node);
  const dependency = existingDependencies.get(logicalId);

  if (dependency !== undefined) {
    if (dependency !== resourceType || node.action !== "noop") {
      throw Error("Access identity would change");
    }

    return;
  }

  if (
    resourceType !== "Cloudflare.Access.Application" ||
    (node.action !== "noop" && node.action !== "update")
  ) {
    throw Error("Existing Access application required");
  }

  requireStagedDestinations({
    logicalId,
    before: node.state.props,
    after: node.action === "noop" ? node.state.props : node.props,
  });
};

export const requireHostPlan = (plan: Plan): void => {
  const rows = describePlan(plan),
    expected = new Set([...existingDependencies.keys(), ...stagedAccessApplications]);

  if (
    plan.selectedFqns === undefined ||
    rows.actions.length !== 0 ||
    rows.resources.length !== expected.size
  ) {
    throw Error("Incomplete filtered Access plan");
  }

  for (const node of Object.values(plan.resources)) {
    const { logicalId } = describeResource(node);

    if (!expected.delete(logicalId) || node.bindings.some((binding) => binding.action !== "noop")) {
      throw Error("Unexpected Access dependency");
    }

    requireStageNode(node);
  }

  if (expected.size !== 0) throw Error("Expected Access resource missing");
};
