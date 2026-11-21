import { BunFileSystem, BunRuntime } from "@effect/platform-bun";
import { Data, Effect, FileSystem, Option, Schema, Stream } from "effect";
import { SourceComment, commentsIn, supportsComments } from "./comment-syntax";

const root = new URL("../", import.meta.url);

const cwd = Bun.fileURLToPath(root);

const baselinePath = "scripts/comment-baseline.txt";

const baselineFile = cwd + baselinePath;

const scanConcurrency = 16;

const vendoredPrefixes = [".agents/skills/install-anti-slop/", "tools/oxlint/anti-slop/"];

class CommentParseFailed extends Data.TaggedError("CommentParseFailed")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

class InvalidCommentLintOption extends Data.TaggedError("InvalidCommentLintOption")<{
  readonly message: string;
}> {}

const git = (args: ReadonlyArray<string>): Bun.SyncSubprocess<"pipe", "pipe"> =>
  Bun.spawnSync(["git", ...args], { cwd });

const sourceFiles = (): ReadonlyArray<string> => {
  const result = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);

  if (result.exitCode !== 0) throw new Error(result.stderr.toString());

  return [...new Set(result.stdout.toString().split("\0"))].filter(
    (file) =>
      !file.split("/").includes(".repos") &&
      !vendoredPrefixes.some((prefix) => file.startsWith(prefix)) &&
      (supportsComments(file) || file.endsWith(".py"))
  );
};

const scanFile = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* fs.stream(cwd + file).pipe(Stream.decodeText(), Stream.mkString);

  return yield* Effect.try({
    try: () => commentsIn({ file, source }),
    catch: (cause) =>
      new CommentParseFailed({ message: `${file}: cannot inventory comments`, cause }),
  });
});

const existingFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  const files = yield* Effect.forEach(
    sourceFiles(),
    (file) =>
      fs.lstat(cwd + file).pipe(
        Effect.map((info) => (info.type === "File" ? Option.some(file) : Option.none())),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone)
      ),
    { concurrency: scanConcurrency }
  );

  return files.flatMap(Option.toArray);
});

const inventoryJson = Schema.fromJsonString(Schema.Array(SourceComment), { space: 2 });

const decodePython = Schema.decodeUnknownSync(inventoryJson);

const encodeInventory = Schema.encodeEffect(inventoryJson);

const scanPython = (files: ReadonlyArray<string>): ReadonlyArray<SourceComment> => {
  if (files.length === 0) return [];
  const python = process.platform === "win32" ? "python" : "python3";

  const result = Bun.spawnSync([python, "scripts/python-comments.py"], {
    cwd,
    stdin: Buffer.from(JSON.stringify(files)),
  });

  if (result.exitCode !== 0) {
    throw new Error(`Python comment scan failed: ${result.stderr.toString()}`);
  }

  return decodePython(result.stdout.toString());
};

const fingerprint = (text: string): string =>
  new Bun.CryptoHasher("sha256").update(text.replaceAll("\r\n", "\n")).digest("base64url");

type Baseline = ReadonlyMap<string, ReadonlyArray<string>>;

const decodePath = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String));

export const readBaseline = (text: string): Baseline =>
  new Map(
    text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [path, ...hashes] = line.split("\t");

        return [decodePath(path), hashes];
      })
  );

const writeBaseline = (paths: Baseline): string =>
  [...paths]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([file, hashes]) => [JSON.stringify(file), ...hashes.toSorted()].join("\t") + "\n")
    .join("");

type LocatedComment = Pick<SourceComment, "file" | "line" | "text">;

type CommentComparison = Readonly<{
  added: ReadonlyArray<LocatedComment>;
  retained: Baseline;
  removed: number;
}>;

export const compareComments = ({
  comments,
  baseline,
}: Readonly<{
  comments: ReadonlyArray<LocatedComment>;
  baseline: Baseline;
}>): CommentComparison => {
  const remaining = new Map([...baseline].map(([file, hashes]) => [file, [...hashes]]));
  const retained = new Map<string, Array<string>>();
  const added: Array<LocatedComment> = [];

  for (const comment of comments) {
    const hash = fingerprint(comment.text);
    const hashes = remaining.get(comment.file);
    const index = hashes?.indexOf(hash) ?? -1;

    if (hashes === undefined || index < 0) {
      added.push(comment);
    } else {
      hashes.splice(index, 1);
      const existing = retained.get(comment.file) ?? [];
      existing.push(hash);
      retained.set(comment.file, existing);
    }
  }

  return { added, retained, removed: [...remaining.values()].flat().length };
};

const baselineAtBase = (): Option.Option<Baseline> => {
  const base = Bun.env.BASE_REF;

  if (base === undefined || base === "") return Option.none();
  const tree = git(["ls-tree", "--name-only", base, "--", baselinePath]);

  if (tree.exitCode !== 0) throw new Error(tree.stderr.toString());

  if (tree.stdout.length === 0) return Option.none();
  const result = git(["show", `${base}:${baselinePath}`]);

  if (result.exitCode !== 0) throw new Error(result.stderr.toString());

  return Option.some(readBaseline(result.stdout.toString()));
};

const checkAgainstBase = (baseline: Baseline): void => {
  const previous = baselineAtBase();

  if (Option.isNone(previous)) return;

  for (const [file, hashes] of baseline) {
    const allowed = Array.from(previous.value.get(file) ?? []);

    for (const hash of hashes) {
      const index = allowed.indexOf(hash);

      if (index < 0) throw new Error(`${file}: comment baseline can only shrink.`);
      allowed.splice(index, 1);
    }
  }
};

const lintComments = Effect.fnUntraced(function* (
  comments: ReadonlyArray<SourceComment>,
  prune: boolean
) {
  const fs = yield* FileSystem.FileSystem;
  const baseline = readBaseline(yield* fs.readFileString(baselineFile));
  checkAgainstBase(baseline);
  const { added, retained, removed } = compareComments({ comments, baseline });

  if (prune) yield* fs.writeFileString(baselineFile, writeBaseline(retained));

  if (removed > 0 && !prune) {
    process.stderr.write(
      `Prune ${removed} removed comment(s) with bun run lint:comments --prune.\n`
    );
  }

  for (const { file, line } of added) {
    process.stderr.write(
      `${file}:${line}: Remove the new comment. Record durable decisions in an ADR.\n`
    );
  }

  if (added.length > 0 || (removed > 0 && !prune)) process.exitCode = 1;
});

const main = Effect.gen(function* () {
  const mode = process.argv[2] ?? "";

  if (mode !== "" && mode !== "--prune" && mode !== "--inventory") {
    return yield* new InvalidCommentLintOption({ message: `Unknown option ${mode}` });
  }

  const files = yield* existingFiles;

  const parsed = yield* Effect.forEach(files.filter(supportsComments), scanFile, {
    concurrency: scanConcurrency,
  });

  const comments = [...parsed.flat(), ...scanPython(files.filter((file) => file.endsWith(".py")))];

  if (mode === "--inventory") {
    process.stdout.write((yield* encodeInventory(comments)) + "\n");

    return;
  }

  yield* lintComments(comments, mode === "--prune");
});

if (import.meta.main) BunRuntime.runMain(main.pipe(Effect.provide(BunFileSystem.layer)));
