import { Array as Arr, Effect, FileSystem, Option, Order, Path } from "effect";
import { EmailCatalogGenerationFailed } from "./contract";

const discoverFormats = Effect.fn(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(root);

  const discovered = yield* Effect.forEach(entries, (entry) =>
    Effect.gen(function* () {
      const directory = path.join(root, entry);

      if ((yield* fs.stat(directory)).type !== "Directory") return Option.none<string>();

      if (!(yield* fs.exists(path.join(directory, "format.ts")))) return Option.none<string>();

      if (!(yield* fs.exists(path.join(directory, "fixtures", "positive.synthetic.html")))) {
        return yield* new EmailCatalogGenerationFailed({ reason: "missing-fixture" });
      }

      return Option.some(`${entry}/format.ts`);
    })
  );

  const paths = Arr.getSomes(discovered);

  if (paths.length === 0) {
    return yield* new EmailCatalogGenerationFailed({ reason: "missing-formats" });
  }

  return Arr.sort(paths, Order.String);
});

const catalogSource = (paths: ReadonlyArray<string>): string => {
  const imports = paths
    .map(
      (path, index) =>
        `import { format as format${index} } from "~/shell/ingestion/internal/email-interpretation/formats/${path.replace(/\.ts$/u, "")}";`
    )
    .join("\n");

  const names = paths.map((_, index) => `format${index}`).join(", ");

  return `import type { NotificationEmailFormat } from "./format-definition";
${imports}

export const generatedFormats: ReadonlyArray<NotificationEmailFormat> = [${names}];
`;
};

export const generateNotificationEmailCatalog = Effect.fn(function* (check: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const formatsRoot = yield* path.fromFileUrl(
    new URL("./internal/email-interpretation/formats", import.meta.url)
  );

  const output = yield* path.fromFileUrl(
    new URL("./internal/email-interpretation/catalog.generated.ts", import.meta.url)
  );

  const content = catalogSource(yield* discoverFormats(formatsRoot));

  if (check) {
    const current = (yield* fs.exists(output)) ? yield* fs.readFileString(output) : "";

    if (current !== content) {
      return yield* new EmailCatalogGenerationFailed({ reason: "stale-catalog" });
    }
  } else {
    yield* fs.writeFileString(output, content);
  }
});
