#!/usr/bin/env bun

/** Use only runners that the ordinary change plan already selects. */
export const sourceScanPlan = ({
  unit,
  sca,
}: Readonly<{ unit: boolean; sca: boolean }>): Readonly<{ count: number; sca: number }> => ({
  count: 2 + Number(unit) + Number(sca),
  sca: 3 + Number(unit),
});

/** Distribute the complete source scope over existing jobs; never select only changed files. */
export const partitionSourceFiles = ({
  files,
  count,
}: Readonly<{
  files: ReadonlyArray<Readonly<{ path: string; bytes: number }>>;
  count: number;
}>): ReadonlyArray<ReadonlyArray<string>> => {
  if (!Number.isInteger(count) || count < 1) throw new Error("Invalid source partition count");
  if (new Set(files.map(({ path }) => path)).size !== files.length) {
    throw new Error("Duplicate source target");
  }
  const partitions = Array.from({ length: count }, () => ({
    files: new Array<string>(),
    weight: 0,
  }));
  for (const file of files.toSorted(
    (left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path)
  )) {
    const target = partitions.reduce((smallest, candidate) =>
      candidate.weight < smallest.weight ? candidate : smallest
    );
    target.files.push(file.path);
    target.weight += Math.max(file.bytes, 1);
  }
  return partitions.map(({ files }) => files.toSorted());
};

const rootPolicy = (value: unknown): object & Readonly<{ sast: unknown }> => {
  if (typeof value !== "object" || value === null || !("sast" in value)) {
    throw new Error("Missing source scan policy");
  }
  return value;
};
const sastPolicy = (value: unknown): object & Readonly<{ include: unknown; exclude: unknown }> => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("include" in value) ||
    !("exclude" in value)
  ) {
    throw new Error("Missing source scan scope");
  }
  return value;
};
const readPolicy = (
  value: unknown
): Readonly<{ policy: object; sast: object; exclude: ReadonlyArray<string> }> => {
  const policy = rootPolicy(value);
  const sast = sastPolicy(policy.sast);
  if ("multifile" in sast && sast.multifile !== false) {
    throw new Error("Cross-file analysis requires an unpartitioned source scan");
  }
  const include: unknown = sast.include;
  const exclude: unknown = sast.exclude;
  if (!Array.isArray(include) || include.length !== 1 || include[0] !== ".") {
    throw new Error("Review partitioning when source includes change");
  }
  if (!Array.isArray(exclude) || !exclude.every((path: unknown) => typeof path === "string")) {
    throw new Error("Invalid source exclusions");
  }
  return { policy, sast, exclude };
};
const maximumScannerBytes = 512_000;
const sourceWeight = (path: string, bytes: number): number =>
  /\.(?:[cm]?[jt]sx?|py|json|ya?ml|sh|sql)$/u.test(path) && bytes <= maximumScannerBytes
    ? bytes
    : 1;

const sourceEntries = (
  exclude: ReadonlyArray<string>
): ReadonlyArray<Readonly<{ path: string; mayBeDirectory: boolean }>> => {
  const result = Bun.spawnSync(["git", "ls-files", "--stage", "-z"]);
  if (result.exitCode !== 0) throw new Error("Unable to enumerate complete source scope");
  const entries = new TextDecoder()
    .decode(result.stdout)
    .split("\u0000")
    .filter((entry) => entry.length > 0)
    .map((entry) => ({
      path: entry.slice(entry.indexOf("\t") + 1),
      mayBeDirectory: entry.startsWith("120000 ") || entry.startsWith("160000 "),
    }))
    .filter(({ path }) => !(exclude.includes("glob(.repos/**)") && path.startsWith(".repos/")))
    .filter(
      ({ path }) =>
        !(exclude.includes("glob(**/node_modules/**)") && path.split("/").includes("node_modules"))
    );
  return entries;
};

const minimumPartitions = 2;
const maximumPartitions = 4;
const validPartitionCount = (count: number): boolean =>
  [minimumPartitions, minimumPartitions + 1, maximumPartitions].includes(count);
const sourceSelection = (selection: string): Readonly<{ index: number; count: number }> => {
  const [index = 0, count = 0, extra] = selection.split("/").map(Number);
  if (
    extra !== undefined ||
    !validPartitionCount(count) ||
    !Number.isInteger(index) ||
    index < 1 ||
    index > count
  ) {
    throw new Error("Use one complete source partition from a 2–4 runner plan");
  }
  return { index, count };
};

const generate = ({
  selection,
  output,
  source,
}: Readonly<{ selection: string; output: string; source: string }>): Promise<void> => {
  const { index, count } = sourceSelection(selection);
  const { policy, sast, exclude } = readPolicy(Bun.YAML.parse(source));
  const entries = sourceEntries(exclude);
  return Promise.all(
    entries.map(({ path, mayBeDirectory }) =>
      Bun.file(path)
        .exists()
        .then((exists) => {
          if (!exists) {
            if (mayBeDirectory) return [];
            throw new Error(`Source target absent from checkout: ${path}`);
          }
          return [{ path, bytes: sourceWeight(path, Bun.file(path).size) }];
        })
    )
  ).then((groups) => {
    const files = groups.flat();
    const partitions = partitionSourceFiles({ files, count });
    const selected = partitions[index - 1];
    if (selected === undefined || selected.length === 0) throw new Error("Empty source partition");
    const union = partitions.flat().toSorted();
    if (
      union.length !== files.length ||
      new Set(union).size !== files.length ||
      files.some(({ path }) => !union.includes(path))
    ) {
      throw new Error("Incomplete source partition coverage");
    }
    const digest = new Bun.CryptoHasher("sha256").update(union.join("\u0000")).digest("hex");
    process.stdout.write(
      `Full source target digest: ${digest}\nPartition sizes: ${partitions.map((part) => part.length).join(", ")}\nSelected: ${selection}\n`
    );
    return Bun.write(
      output,
      Bun.YAML.stringify({ ...policy, sast: { ...sast, include: selected } })
    ).then(() => undefined);
  });
};
if (import.meta.main) {
  const selection = Bun.argv[2];
  const output = Bun.argv[3];
  if (selection === undefined || output === undefined || Bun.argv.length !== 4) {
    throw new Error("Usage: bun scripts/partition-source-scan.ts index/count output.yaml");
  }
  const source = await Bun.file(".fluidattacks/sast.yaml").text();
  await generate({ selection, output, source });
}
