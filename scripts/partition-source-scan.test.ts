import { expect, it } from "vitest";
import { partitionSourceFiles } from "./partition-source-scan";

it("balances the complete source scope without duplication, omissions, or input-order dependence", () => {
  const files = [
    { path: "large.ts", bytes: 60 },
    { path: "medium.ts", bytes: 40 },
    { path: "small.ts", bytes: 30 },
    { path: "tiny.ts", bytes: 20 },
    { path: "header.txt", bytes: 0 },
    { path: "other.ts", bytes: 10 },
  ];
  const parts = partitionSourceFiles({ files, count: 3 });
  expect(parts).toEqual(partitionSourceFiles({ files: files.toReversed(), count: 3 }));
  expect(parts.flat().toSorted()).toEqual(files.map(({ path }) => path).toSorted());
  expect(new Set(parts.flat()).size).toBe(files.length);
  const bytes = new Map(files.map(({ path, bytes }) => [path, bytes]));
  expect(
    Math.max(...parts.map((part) => part.reduce((sum, path) => sum + (bytes.get(path) ?? 0), 0)))
  ).toBe(60);
});

it("refuses invalid partition counts and duplicated source targets", () => {
  const files = [{ path: "source.ts", bytes: 10 }];
  for (const count of [0, -1, 1.5]) expect(() => partitionSourceFiles({ files, count })).toThrow();
  expect(() => partitionSourceFiles({ files: [...files, ...files], count: 3 })).toThrow(
    "Duplicate"
  );
});
