#!/usr/bin/env bun

import { Option } from "effect";

const webRoot = Bun.fileURLToPath(new URL("..", import.meta.url));
const probePrefix = `__probe-${process.pid}-`;

type ProbeFile = Readonly<{ path: string; source: string }>;
type Expectation =
  | Readonly<{ kind: "allowed" }>
  | Readonly<{ kind: "rejected"; mustContain: readonly string[] }>;
type Probe = Readonly<{ expect: Expectation; files: readonly ProbeFile[]; name: string }>;

const sourcePath = (slug: string): string => `src/${probePrefix}${slug}`;
const featurePath = (slug: string): string => `src/features/${probePrefix}${slug}`;
const appPath = (slug: string): string => `src/app/${probePrefix}${slug}`;
const uiPath = (slug: string): string => `src/ui/${probePrefix}${slug}`;
const sessionPath = (slug: string): string => `src/session/${probePrefix}${slug}`;
const transportPath = (slug: string): string => `src/transport/${probePrefix}${slug}`;

const featureSiblingA = featurePath("sibling-a");
const featureSiblingB = featurePath("sibling-b");
const featurePrivate = featurePath("private");
const featureApplication = featurePath("application");
const appPrivate = appPath("private");
const appInterface = appPath("interface");
const uiApplication = uiPath("application");
const testingFeaturePrivate = `src/testing/${probePrefix}feature-private`;
const testingServerInternal = `src/testing/${probePrefix}server-internal`;
const sessionFeature = sessionPath("feature");
const sessionApplication = sessionPath("application");
const sessionUi = sessionPath("ui");
const transportFeature = transportPath("feature");
const transportApplication = transportPath("application");
const transportSession = transportPath("session");
const transportUi = transportPath("ui");
const transportOwner = featurePath("client-bypass");
const sourceEntrypoint = sourcePath("entrypoint");
const sourceCycle = sourcePath("cycle");
const sourceBarrel = sourcePath("barrel");
const sourceAlias = appPath("alias");
const sourceRelative = appPath("relative");

const probes: readonly Probe[] = [
  {
    name: "feature-to-feature imports are rejected",
    expect: {
      kind: "rejected",
      mustContain: [`error feature-imports-sibling: ${featureSiblingA}/probe.ts`],
    },
    files: [
      {
        path: `${featureSiblingA}/probe.ts`,
        source: `import { SiblingFeature } from "@/features/${probePrefix}sibling-b/feature";\n\nexport const featureSiblingProbe = SiblingFeature;\n`,
      },
      {
        path: `${featureSiblingB}/feature.tsx`,
        source: 'export const SiblingFeature = "probe" as const;\n',
      },
    ],
  },
  {
    name: "feature interface imports remain allowed",
    expect: { kind: "allowed" },
    files: [
      {
        path: `${appInterface}/probe.ts`,
        source: `import { HomeFeature } from "@/features/home/feature";\n\nexport const featureInterfaceProbe = HomeFeature;\n`,
      },
    ],
  },
  {
    name: "composition cannot import feature private modules",
    expect: {
      kind: "rejected",
      mustContain: [`error application-imports-feature-private: ${appPrivate}/probe.ts`],
    },
    files: [
      {
        path: `${appPrivate}/probe.ts`,
        source: `import { PrivateValue } from "@/features/${probePrefix}private/private";\n\nexport const applicationPrivateProbe = PrivateValue;\n`,
      },
      {
        path: `${featurePrivate}/private.ts`,
        source: 'export const PrivateValue = "probe" as const;\n',
      },
    ],
  },
  {
    name: "features cannot import the composition root",
    expect: {
      kind: "rejected",
      mustContain: [`error feature-imports-application: ${featureApplication}/probe.ts`],
    },
    files: [
      {
        path: `${featureApplication}/probe.ts`,
        source:
          'import { createWebApplication } from "@/app/application";\n\n' +
          "export const featureApplicationProbe = createWebApplication;\n",
      },
    ],
  },
  {
    name: "ownerless UI cannot import application code",
    expect: {
      kind: "rejected",
      mustContain: [`error ui-imports-application-code: ${uiApplication}/probe.ts`],
    },
    files: [
      {
        path: `${uiApplication}/probe.ts`,
        source:
          'import { HomeFeature } from "@/features/home/feature";\n\n' +
          "export const uiApplicationProbe = HomeFeature;\n",
      },
    ],
  },
  {
    name: "non-feature modules cannot import feature private code",
    expect: {
      kind: "rejected",
      mustContain: [`error non-feature-imports-feature-private: ${testingFeaturePrivate}/probe.ts`],
    },
    files: [
      {
        path: `${testingFeaturePrivate}/probe.ts`,
        source:
          `import { PrivateValue } from "@/features/${probePrefix}private/private";\n\n` +
          "export const testingFeaturePrivateProbe = PrivateValue;\n",
      },
      {
        path: `${featurePrivate}/private.ts`,
        source: 'export const PrivateValue = "probe" as const;\n',
      },
    ],
  },
  {
    name: "web source cannot import server internals",
    expect: {
      kind: "rejected",
      mustContain: [`error web-imports-server-internal: ${testingServerInternal}/probe.ts`],
    },
    files: [
      {
        path: `${testingServerInternal}/probe.ts`,
        source:
          'import type { Identity } from "../../../../server/src/core/identity/model";\n\n' +
          "export type ServerInternalProbe = Identity;\n",
      },
    ],
  },
  {
    name: "session cannot import features",
    expect: {
      kind: "rejected",
      mustContain: [`error session-imports-features: ${sessionFeature}/probe.ts`],
    },
    files: [
      {
        path: `${sessionFeature}/probe.ts`,
        source:
          'import { HomeFeature } from "@/features/home/feature";\n\n' +
          "export const sessionFeatureProbe = HomeFeature;\n",
      },
    ],
  },
  {
    name: "session cannot import the composition root",
    expect: {
      kind: "rejected",
      mustContain: [`error session-imports-application: ${sessionApplication}/probe.ts`],
    },
    files: [
      {
        path: `${sessionApplication}/probe.ts`,
        source:
          'import { WebApplication } from "@/app/application";\n\n' +
          "export const sessionApplicationProbe = WebApplication;\n",
      },
    ],
  },
  {
    name: "session cannot import ownerless UI",
    expect: {
      kind: "rejected",
      mustContain: [`error session-imports-ui: ${sessionUi}/probe.ts`],
    },
    files: [
      {
        path: `${sessionUi}/probe.ts`,
        source:
          'import { PublicPage } from "@/ui/public-page";\n\n' +
          "export const sessionUiProbe = PublicPage;\n",
      },
    ],
  },
  {
    name: "transport cannot import features",
    expect: {
      kind: "rejected",
      mustContain: [`error transport-imports-features: ${transportFeature}/probe.ts`],
    },
    files: [
      {
        path: `${transportFeature}/probe.ts`,
        source:
          'import { HomeFeature } from "@/features/home/feature";\n\n' +
          "export const transportFeatureProbe = HomeFeature;\n",
      },
    ],
  },
  {
    name: "transport cannot import the composition root",
    expect: {
      kind: "rejected",
      mustContain: [`error transport-imports-application: ${transportApplication}/probe.ts`],
    },
    files: [
      {
        path: `${transportApplication}/probe.ts`,
        source:
          'import { WebApplication } from "@/app/application";\n\n' +
          "export const transportApplicationProbe = WebApplication;\n",
      },
    ],
  },
  {
    name: "transport cannot import session",
    expect: {
      kind: "rejected",
      mustContain: [`error transport-imports-session: ${transportSession}/probe.ts`],
    },
    files: [
      {
        path: `${transportSession}/probe.ts`,
        source:
          'import { SessionRegistryProvider } from "@/session/session";\n\n' +
          "export const transportSessionProbe = SessionRegistryProvider;\n",
      },
    ],
  },
  {
    name: "transport cannot import ownerless UI",
    expect: {
      kind: "rejected",
      mustContain: [`error transport-imports-ui: ${transportUi}/probe.ts`],
    },
    files: [
      {
        path: `${transportUi}/probe.ts`,
        source:
          'import { PublicPage } from "@/ui/public-page";\n\n' +
          "export const transportUiProbe = PublicPage;\n",
      },
    ],
  },
  {
    name: "the canonical server client is transport-owned",
    expect: {
      kind: "rejected",
      mustContain: [`error server-client-imported-outside-transport: ${transportOwner}/probe.ts`],
    },
    files: [
      {
        path: `${transportOwner}/probe.ts`,
        source:
          'import { FidyApi } from "@fidy/server/client";\n\n' +
          "export const transportOwnerProbe = FidyApi;\n",
      },
    ],
  },
  {
    name: "the entrypoint is not imported",
    expect: {
      kind: "rejected",
      mustContain: [`error entrypoint-is-imported: ${sourceEntrypoint}/probe.ts`],
    },
    files: [
      {
        path: `${sourceEntrypoint}/probe.ts`,
        source: 'import "@/main";\n\nexport const entrypointProbe = true;\n',
      },
    ],
  },
  {
    name: "cycles are rejected",
    expect: {
      kind: "rejected",
      mustContain: [`error cycle:`, `${sourceCycle}/a.ts`, `${sourceCycle}/b.ts`],
    },
    files: [
      {
        path: `${sourceCycle}/a.ts`,
        source:
          'import type { ProbeB } from "./b";\n\nexport type ProbeA = { readonly b: ProbeB };\n',
      },
      {
        path: `${sourceCycle}/b.ts`,
        source:
          'import type { ProbeA } from "./a";\n\nexport type ProbeB = { readonly a: ProbeA };\n',
      },
    ],
  },
  {
    name: "barrels are rejected",
    expect: {
      kind: "rejected",
      mustContain: [`error barrel-file: ${sourceBarrel}/probe.ts → ${sourceBarrel}/index.ts`],
    },
    files: [
      { path: `${sourceBarrel}/index.ts`, source: "export const barrelProbe = true;\n" },
      {
        path: `${sourceBarrel}/probe.ts`,
        source:
          'import { barrelProbe } from "./index";\n\nexport const barrelUser = barrelProbe;\n',
      },
    ],
  },
  {
    name: "same-directory imports are relative",
    expect: {
      kind: "rejected",
      mustContain: [`error same-directory-import-is-relative: ${sourceAlias}/probe.ts`],
    },
    files: [
      { path: `${sourceAlias}/neighbour.ts`, source: "export const neighbour = true;\n" },
      {
        path: `${sourceAlias}/probe.ts`,
        source:
          `import { neighbour } from "@/${sourceAlias.replace("src/", "")}/neighbour";\n\n` +
          "export const aliasProbe = neighbour;\n",
      },
    ],
  },
  {
    name: "cross-directory imports use the alias",
    expect: {
      kind: "rejected",
      mustContain: [`error cross-directory-import-is-aliased: ${sourceRelative}/probe.ts`],
    },
    files: [
      {
        path: `${sourceRelative}/probe.ts`,
        source:
          'import { HomeFeature } from "../../features/home/feature";\n\n' +
          "export const relativeProbe = HomeFeature;\n",
      },
    ],
  },
];

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const runGraph = (): Readonly<{ exitCode: Option.Option<number>; report: string }> => {
  const result = Bun.spawnSync(["bun", "../../tools/depcruise/run.mjs"], {
    cwd: webRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: Option.fromNullOr(result.exitCode),
    report: `${decode(result.stdout)}\n${decode(result.stderr)}`,
  };
};
const remove = (path: string): void => {
  const result = Bun.spawnSync(["rm", "-rf", path], { stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(decode(result.stderr));
};
const removeProbeFiles = (probe: Probe): void => {
  const directories = new Set(probe.files.map(({ path }) => path.slice(0, path.lastIndexOf("/"))));
  for (const directory of directories) remove(`${webRoot}/${directory}`);
};
const missingFrom = (report: string, expected: readonly string[]): readonly string[] =>
  expected.filter((entry) => !report.includes(entry));

const assertProbe = (probe: Probe): void => {
  const { exitCode, report } = runGraph();
  if (probe.expect.kind === "allowed") {
    if (!Option.contains(exitCode, 0)) {
      throw new Error(`${probe.name}\nThe graph rejected an allowed import.\n${report}`);
    }
    return;
  }
  const missing = missingFrom(report, probe.expect.mustContain);
  if (Option.contains(exitCode, 0)) {
    throw new Error(`${probe.name}\nThe graph passed despite the expected violation.\n${report}`);
  }
  if (missing.length > 0) {
    throw new Error(
      `${probe.name}\nThe graph failed for another reason. Missing: ${missing.join(" | ")}\n${report}`
    );
  }
};

for (const probe of probes) {
  try {
    await Promise.all(probe.files.map((file) => Bun.write(`${webRoot}/${file.path}`, file.source)));
    assertProbe(probe);
  } finally {
    removeProbeFiles(probe);
  }
  process.stdout.write(`ok  ${probe.name}\n`);
}

process.stdout.write(`\nall ${probes.length} web dependency guard probes passed\n`);
