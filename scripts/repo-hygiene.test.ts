import { expect, test } from "bun:test";
import { Schema } from "effect";

const Lock = Schema.Struct({
  version: Schema.Int,
  skills: Schema.Record(Schema.String, Schema.Struct({ computedHash: Schema.String })),
});

const read = (path: string): Uint8Array => Bun.spawnSync(["cat", path], { stdout: "pipe" }).stdout;

const readText = (path: string): string => new TextDecoder().decode(read(path));

const filesIn = (directory: string): string[] =>
  Array.from(new Bun.Glob(`${directory}/**/*`).scanSync({ onlyFiles: true })).sort();

const treeHash = (directory: string): string => {
  const hash = new Bun.CryptoHasher("sha256");

  const files = filesIn(directory).sort((left, right) =>
    left.slice(directory.length + 1).localeCompare(right.slice(directory.length + 1))
  );

  for (const file of files) {
    hash.update(file.slice(directory.length + 1));
    hash.update("\0");
    hash.update(read(file));
    hash.update("\0");
  }

  return hash.digest("hex");
};

test("workflows install the checksum-pinned Bun runtime", () => {
  const directory = ".github/workflows";
  const forbidden = ["oven-sh/setup-bun", "bun-version:"];

  const failures = filesIn(directory)
    .filter((path) => path.endsWith(".yml"))
    .flatMap((path) => {
      const source = readText(path);

      return forbidden.flatMap((needle) => (source.includes(needle) ? [`${path}: ${needle}`] : []));
    });

  expect(failures).toEqual([]);
});

test("locked skill trees match and the shadcn instructions stay pinned", () => {
  const lock = Schema.decodeSync(Schema.fromJsonString(Lock))(readText("skills-lock.json"));

  for (const [name, entry] of Object.entries(lock.skills)) {
    expect(entry.computedHash).toBe(treeHash(`.agents/skills/${name}`));
  }

  const directory = ".agents/skills/shadcn";

  for (const file of filesIn(directory)) {
    if (file.endsWith("SOURCE.md")) continue;

    expect(readText(file).includes("shadcn@latest")).toBe(false);
  }

  expect(readText(`${directory}/SOURCE.md`)).toContain("a85299a9");
});

test("trunk pushes deploy the native release", () => {
  const source = readText(".github/workflows/native-storage-release.yml");

  expect(source).toMatch(/on:\s*\n\s*push:/u);
  expect(source).toContain("branches: [trunk]");
  expect(source).toContain("RELEASE_OPERATION: ${{ inputs.operation || 'rollout' }}");
});
