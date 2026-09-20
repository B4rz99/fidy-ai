#!/usr/bin/env bun

type WallClockAllowance = Readonly<{
  file: string;
  duration: string;
  count: number;
  reason: string;
}>;

const serverRoot = Bun.fileURLToPath(new URL("..", import.meta.url));
const wallClockAllowances: ReadonlyArray<WallClockAllowance> = [
  {
    file: "src/shell/agent/hosted-turns.integration.test.ts",
    duration: '"2100 millis"',
    count: 1,
    reason: "proves accepted WhatsApp work survives beyond the removed two-second caller deadline",
  },
  {
    file: "src/shell/agent/hosted-turns.integration.test.ts",
    duration: '"1 second"',
    count: 1,
    reason: "allows a real remote interruption to cross the Cluster transport before release",
  },
  {
    file: "src/shell/channels/whatsapp/disclosure-delivery.test.ts",
    duration: '"2200 millis"',
    count: 1,
    reason: "proves terminal evidence cancels the already-scheduled two-second durable retry",
  },
  {
    file: "src/shell/channels/whatsapp/whatsapp.acceptance.test.ts",
    duration: '"100 millis"',
    count: 1,
    reason: "negative acceptance assertion that duplicate ambiguous webhooks do not send twice",
  },
  {
    file: "src/shell/channels/whatsapp/whatsapp.acceptance.test.ts",
    duration: '"3 seconds"',
    count: 1,
    reason:
      "negative acceptance assertion that ambiguous delivery remains unresolved past retry time",
  },
];

const allowanceKey = (file: string, duration: string): string => `${file}\u0000${duration}`;
const expected = new Map(
  wallClockAllowances.map(({ file, duration, count, reason }) => [
    allowanceKey(file, duration),
    { count, reason },
  ])
);
const observed = new Map<string, number>();
const violations: Array<string> = [];
const tests = new Bun.Glob("src/**/*.test.ts");

for await (const file of tests.scan({ cwd: serverRoot })) {
  const source = await Bun.file(`${serverRoot}${file}`).text();
  for (const match of source.matchAll(/Effect\.sleep\(([^)\n]+)\)/gu)) {
    const duration = match[1]?.trim();
    if (duration === undefined) continue;
    const key = allowanceKey(file, duration);
    observed.set(key, (observed.get(key) ?? 0) + 1);
    if (!expected.has(key)) violations.push(`${file}: unexplained Effect.sleep(${duration})`);
  }

  if (
    file.endsWith(".integration.test.ts") &&
    (/\bport:\s*\d{4,5}\b/u.test(source) ||
      /\b(?:acquireRuntime|runtimeFor|makeRuntimeLayer)\(\s*\d{4,5}\b/u.test(source))
  ) {
    violations.push(`${file}: fixed listener port; use availableLoopbackPort`);
  }
}

for (const [key, allowance] of expected) {
  const count = observed.get(key) ?? 0;
  if (count !== allowance.count) {
    const [file, duration] = key.split("\u0000");
    violations.push(
      `${file}: expected ${allowance.count} allowed Effect.sleep(${duration}), observed ${count}; ${allowance.reason}`
    );
  }
}

if (violations.length > 0) {
  throw new Error(`Test time policy violations:\n${violations.join("\n")}`);
}
