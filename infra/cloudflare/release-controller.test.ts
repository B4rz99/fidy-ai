import { Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  type Deployment,
  type ReleasePort,
  type ReleaseSnapshot,
  captureRelease,
  promoteRelease,
  stageRelease,
} from "./release-controller";
import { cleanRelease } from "./release-cleanup";

const publicName = "fidy-ingress";
const coreName = "fidy-core";
const versions = {
  publicStable: "11111111-1111-4111-8111-111111111111",
  coreStable: "22222222-2222-4222-8222-222222222222",
  publicCandidate: "33333333-3333-4333-8333-333333333333",
  coreCandidate: "44444444-4444-4444-8444-444444444444",
};
const revision = "a".repeat(40);
type Harness = Readonly<{
  port: ReleasePort;
  changes: string[];
  supersede: () => void;
  fail: (step: string) => void;
}>;
const harness = (): Harness => {
  const deployments = new Map<string, Deployment>([
    [
      publicName,
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        versions: [{ id: versions.publicStable, percentage: 100 }],
      },
    ],
    [
      coreName,
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        versions: [{ id: versions.coreStable, percentage: 100 }],
      },
    ],
  ]);
  const changes: string[] = [];
  let trunk = revision;
  let failOn = Option.none<string>();
  const port: ReleasePort = {
    trunk: async () => trunk,
    current: async (name) => {
      const deployment = deployments.get(name);
      if (!deployment) {
        throw Error("missing deployment");
      }
      return structuredClone(deployment);
    },
    deploy: async (name, entries) => {
      const step = `${name}:${entries.map((version) => version.percentage).join("/")}`;
      changes.push(step);
      if (Option.contains(failOn, step)) {
        throw Error("provider refused");
      }
      const result: Deployment = {
        id: `${String(changes.length).padStart(8, "0")}-cccc-4ccc-8ccc-cccccccccccc`,
        versions: [...entries],
      };
      deployments.set(name, result);
      return result;
    },
  };
  return {
    port,
    changes,
    supersede: (): void => {
      trunk = "b".repeat(40);
    },
    fail: (step: string): void => {
      failOn = Option.some(step);
    },
  };
};
const candidates = {
  publicVersionId: versions.publicCandidate,
  coreVersionId: versions.coreCandidate,
};
const captured = async (port: ReleasePort): Promise<ReleaseSnapshot> =>
  captureRelease(port, {
    revision,
    stableRevision: "b".repeat(40),
    stableContractDigest: "c".repeat(64),
    publicName,
    coreName,
  });

describe("zero-traffic Worker release", () => {
  it("keeps stable versions at 100% while staging exact candidates", async () => {
    const fixture = harness();
    await stageRelease(fixture.port, await captured(fixture.port), candidates);
    expect((await fixture.port.current(publicName)).versions).toEqual([
      { id: versions.publicStable, percentage: 100 },
      { id: versions.publicCandidate, percentage: 0 },
    ]);
    expect((await fixture.port.current(coreName)).versions).toEqual([
      { id: versions.coreStable, percentage: 100 },
      { id: versions.coreCandidate, percentage: 0 },
    ]);
  });

  it("removes a failed smoke candidate without changing stable traffic", async () => {
    const fixture = harness();
    const staged = await stageRelease(fixture.port, await captured(fixture.port), candidates);
    await cleanRelease(fixture.port, staged.snapshot, candidates);
    expect((await fixture.port.current(publicName)).versions).toEqual([
      { id: versions.publicStable, percentage: 100 },
    ]);
    expect((await fixture.port.current(coreName)).versions).toEqual([
      { id: versions.coreStable, percentage: 100 },
    ]);
  });

  it("cleans only its own partially staged candidate after a Core staging failure", async () => {
    const fixture = harness();
    const snapshot = await captured(fixture.port);
    fixture.fail(`${coreName}:100/0`);
    await expect(stageRelease(fixture.port, snapshot, candidates)).rejects.toThrow(
      "provider refused"
    );
    await cleanRelease(fixture.port, snapshot, candidates);
    expect((await fixture.port.current(publicName)).versions).toEqual([
      { id: versions.publicStable, percentage: 100 },
    ]);
    expect((await fixture.port.current(coreName)).versions).toEqual([
      { id: versions.coreStable, percentage: 100 },
    ]);
  });

  it("refuses to clean an unknown staged version", async () => {
    const fixture = harness();
    const snapshot = await captured(fixture.port);
    await fixture.port.deploy(publicName, [
      { id: versions.publicStable, percentage: 100 },
      { id: versions.coreCandidate, percentage: 0 },
    ]);
    await expect(cleanRelease(fixture.port, snapshot, candidates)).rejects.toThrow("unexpected");
    expect(fixture.changes).toHaveLength(1);
  });

  it("refuses superseded work without changing traffic", async () => {
    const fixture = harness();
    const snapshot = await captured(fixture.port);
    fixture.supersede();
    await expect(stageRelease(fixture.port, snapshot, candidates)).rejects.toThrow("superseded");
    expect(fixture.changes).toEqual([]);
  });

  it("refuses to overwrite a changed deployment", async () => {
    const fixture = harness();
    const snapshot = await captured(fixture.port);
    await fixture.port.deploy(coreName, [{ id: versions.coreCandidate, percentage: 100 }]);
    await expect(stageRelease(fixture.port, snapshot, candidates)).rejects.toThrow("changed");
    expect(fixture.changes).toHaveLength(1);
  });

  it("promotes the tested pair in Core-first order", async () => {
    const fixture = harness();
    const staged = await stageRelease(fixture.port, await captured(fixture.port), candidates);
    await promoteRelease(fixture.port, staged, { exactPairPassed: true, middlePairPassed: true });
    expect(fixture.changes).toEqual([
      `${publicName}:100/0`,
      `${coreName}:100/0`,
      `${coreName}:100`,
      `${publicName}:100`,
    ]);
    expect((await fixture.port.current(publicName)).versions).toEqual([
      { id: versions.publicCandidate, percentage: 100 },
    ]);
    expect((await fixture.port.current(coreName)).versions).toEqual([
      { id: versions.coreCandidate, percentage: 100 },
    ]);
  });

  it("does not promote if either pairing fails smoke", async () => {
    const fixture = harness();
    const staged = await stageRelease(fixture.port, await captured(fixture.port), candidates);
    await expect(
      promoteRelease(fixture.port, staged, { exactPairPassed: true, middlePairPassed: false })
    ).rejects.toThrow("smoke");
    expect(fixture.changes).toHaveLength(2);
  });

  it("leaves stable traffic untouched if trunk moves while smoke runs", async () => {
    const fixture = harness();
    const staged = await stageRelease(fixture.port, await captured(fixture.port), candidates);
    fixture.supersede();
    await expect(
      promoteRelease(fixture.port, staged, { exactPairPassed: true, middlePairPassed: true })
    ).rejects.toThrow("superseded");
    expect(fixture.changes).toHaveLength(2);
  });

  it("refuses promotion if a staged deployment changed after smoke", async () => {
    const fixture = harness();
    const staged = await stageRelease(fixture.port, await captured(fixture.port), candidates);
    await fixture.port.deploy(publicName, [{ id: versions.publicCandidate, percentage: 100 }]);
    await expect(
      promoteRelease(fixture.port, staged, { exactPairPassed: true, middlePairPassed: true })
    ).rejects.toThrow("changed");
    expect((await fixture.port.current(coreName)).versions[0]).toEqual({
      id: versions.coreStable,
      percentage: 100,
    });
  });

  it("refuses to restore Core if public promotion committed but the response was lost", async () => {
    const fixture = harness();
    const staged = await stageRelease(fixture.port, await captured(fixture.port), candidates);
    const original = fixture.port;
    const ambiguous: ReleasePort = {
      ...original,
      deploy: async (name, entries) => {
        const result = await original.deploy(name, entries);
        if (name === publicName && entries.length === 1) {
          throw Error("response lost after commit");
        }
        return result;
      },
    };
    await expect(
      promoteRelease(ambiguous, staged, { exactPairPassed: true, middlePairPassed: true })
    ).rejects.toThrow("restoration not confirmed");
    expect((await original.current(coreName)).versions).toEqual([
      { id: versions.coreCandidate, percentage: 100 },
    ]);
  });

  it("restores stable Core when public promotion fails without committing", async () => {
    const fixture = harness();
    const staged = await stageRelease(fixture.port, await captured(fixture.port), candidates);
    fixture.fail(`${publicName}:100`);
    await expect(
      promoteRelease(fixture.port, staged, { exactPairPassed: true, middlePairPassed: true })
    ).rejects.toThrow("restored");
    expect((await fixture.port.current(coreName)).versions).toEqual([
      { id: versions.coreStable, percentage: 100 },
    ]);
    expect((await fixture.port.current(publicName)).versions[0]).toEqual({
      id: versions.publicStable,
      percentage: 100,
    });
  });
});
