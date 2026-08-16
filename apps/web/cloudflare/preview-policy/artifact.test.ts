import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_FILES, validateAndExtract } from "./artifact";

const headSha = "a".repeat(40);
const contractDigest = "b".repeat(64);
const trustedHeaders = "/*\n  Content-Security-Policy: connect-src 'none'\n";
const encoder = new TextEncoder();
const roots: Array<string> = [];

type TarEntry = {
  readonly path: string;
  readonly contents: Uint8Array;
  readonly type: number;
  readonly linkName: string;
};

type TarFieldWrite = {
  readonly target: Uint8Array;
  readonly offset: number;
  readonly length: number;
  readonly value: string;
};

const bytes = (value: string): Uint8Array => encoder.encode(value);

const writeString = (field: TarFieldWrite): void => {
  const encoded = bytes(field.value);
  if (encoded.length > field.length) {
    throw new Error(`Tar test field is too long: ${field.value}`);
  }
  field.target.set(encoded, field.offset);
};

const writeOctal = (field: Omit<TarFieldWrite, "value"> & { readonly value: number }): void => {
  writeString({
    ...field,
    length: field.length - 1,
    value: field.value.toString(8).padStart(field.length - 1, "0"),
  });
};

const tarArchive = (entries: ReadonlyArray<TarEntry>): Uint8Array => {
  const chunks: Array<Uint8Array> = [];
  for (const entry of entries) {
    const header = new Uint8Array(512);
    writeString({ target: header, offset: 0, length: 100, value: entry.path });
    writeOctal({ target: header, offset: 100, length: 8, value: 0o644 });
    writeOctal({ target: header, offset: 108, length: 8, value: 0 });
    writeOctal({ target: header, offset: 116, length: 8, value: 0 });
    writeOctal({ target: header, offset: 124, length: 12, value: entry.contents.length });
    writeOctal({ target: header, offset: 136, length: 12, value: 0 });
    header.fill(0x20, 148, 156);
    header[156] = entry.type;
    writeString({ target: header, offset: 157, length: 100, value: entry.linkName });
    writeString({ target: header, offset: 257, length: 6, value: "ustar" });
    writeString({ target: header, offset: 263, length: 2, value: "00" });
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeString({
      target: header,
      offset: 148,
      length: 6,
      value: checksum.toString(8).padStart(6, "0"),
    });
    header[154] = 0;
    header[155] = 0x20;
    chunks.push(header, entry.contents);
    const padding = (512 - (entry.contents.length % 512)) % 512;
    if (padding > 0) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024));
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const archive = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.length;
  }
  return archive;
};

const metadata = (): Uint8Array => bytes(JSON.stringify({ contractDigest, gitRevision: headSha }));

const regular = (path: string, contents: string | Uint8Array): TarEntry => ({
  path,
  contents: typeof contents === "string" ? bytes(contents) : contents,
  linkName: "",
  type: 0x30,
});

const validEntries = (): ReadonlyArray<TarEntry> => [
  regular("index.html", "<!doctype html><script src='/assets/app-a1b2c3.js'></script>"),
  regular("_headers", trustedHeaders),
  regular("preview-metadata.json", metadata()),
  regular("assets/app-a1b2c3.js", "console.log('preview')"),
];

type ValidationFixture = {
  readonly outputPath: string;
  readonly root: string;
  readonly run: () => Promise<void>;
};

const validationFixture = async (archive: Uint8Array): Promise<ValidationFixture> => {
  const root = await mkdtemp(join(tmpdir(), "fidy-preview-policy-"));
  roots.push(root);
  const archivePath = join(root, "preview.tar");
  const headersPath = join(root, "trusted-headers");
  const outputPath = join(root, "dist");
  await Promise.all([writeFile(archivePath, archive), writeFile(headersPath, trustedHeaders)]);
  return {
    outputPath,
    root,
    run: () =>
      validateAndExtract({
        archivePath,
        expectedDigest: contractDigest,
        expectedSha: headSha,
        outputDirectory: outputPath,
        trustedHeadersPath: headersPath,
      }),
  };
};

const validateArchive = async (archive: Uint8Array): Promise<string> => {
  const fixture = await validationFixture(archive);
  await fixture.run();
  return fixture.outputPath;
};

const expectRejectedWithoutOutput = async (
  entries: ReadonlyArray<TarEntry>,
  message: string
): Promise<void> => {
  const fixture = await validationFixture(tarArchive(entries));
  await expect(fixture.run()).rejects.toThrow(message);
  expect(await Bun.file(fixture.outputPath).exists()).toBe(false);
  expect(await Bun.file(join(fixture.root, "escape.txt")).exists()).toBe(false);
};

const validate = (entries: ReadonlyArray<TarEntry>): Promise<string> =>
  validateArchive(tarArchive(entries));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("preview artifact policy", () => {
  it("extracts a static artifact matching trusted metadata and headers", async () => {
    const output = await validate(validEntries());

    expect([...(await readFile(join(output, "preview-metadata.json")))]).toEqual([...metadata()]);
    expect(await Bun.file(join(output, "assets/app-a1b2c3.js")).exists()).toBe(true);
  });

  it("accepts the uncompressed archive format emitted by Bun", async () => {
    const archive = new Bun.Archive(
      Object.fromEntries(validEntries().map((entry) => [entry.path, entry.contents]))
    );

    await expect(validateArchive(await archive.bytes())).resolves.toBeTypeOf("string");
  });

  it("rejects an unsafe archive path without extracting anything", async () => {
    await expectRejectedWithoutOutput(
      [...validEntries(), regular("../escape.txt", "escaped")],
      "unsafe archive path"
    );
  });

  it("rejects excessive entries without creating output", async () => {
    const entries = [
      ...validEntries(),
      ...Array.from({ length: MAX_FILES }, (_, index) => regular(`assets/extra-${index}.js`, "")),
    ];

    await expectRejectedWithoutOutput(entries, "too many entries");
  });

  it("rejects a symbolic link", async () => {
    const link: TarEntry = {
      path: "assets/link.js",
      contents: new Uint8Array(),
      linkName: "../../outside",
      type: 0x32,
    };

    await expectRejectedWithoutOutput([...validEntries(), link], "regular file");
  });

  it("rejects worker entrypoints, deployment configuration, maps, and server material", async () => {
    await Promise.all(
      [
        "_worker.js",
        "wrangler.jsonc",
        "assets/application.js.map",
        "assets/server.js",
        "assets/sw.js",
      ].map((path) =>
        expectRejectedWithoutOutput(
          [...validEntries(), regular(path, "forbidden")],
          "forbidden artifact path"
        )
      )
    );
  });

  it("rejects Secret and Production server material", async () => {
    await Promise.all(
      ["DATABASE_URL", "HTTPS://API.FIDYAPP.COM"].map((marker) => {
        const entries = validEntries().map((entry) =>
          entry.path === "assets/app-a1b2c3.js" ? regular(entry.path, marker) : entry
        );
        return expectRejectedWithoutOutput(
          entries,
          "forbidden server, Secret, or Production material"
        );
      })
    );
  });

  it("rejects inline or remote source-map directives", async () => {
    await Promise.all(
      [
        "//# sourceMappingURL=data:application/json;base64,e30=",
        "/*# sourceMappingURL=https://example.invalid/app.js.map */",
        JSON.stringify({ mappings: "AAAA", sources: ["secret.ts"], version: 3 }),
        JSON.stringify({ sections: [{ map: { sources: ["secret.ts"] } }], version: 3 }),
      ].map((directive) => {
        const entries = validEntries().map((entry) =>
          entry.path === "assets/app-a1b2c3.js" ? regular(entry.path, directive) : entry
        );
        return expectRejectedWithoutOutput(entries, "source-map material");
      })
    );
  });

  it("rejects malformed metadata", async () => {
    const entries = validEntries().map((entry) =>
      entry.path === "preview-metadata.json" ? regular(entry.path, "[]") : entry
    );

    await expectRejectedWithoutOutput(entries, "metadata does not match");
  });

  it("rejects metadata for a different revision", async () => {
    const changedMetadata = bytes(JSON.stringify({ contractDigest, gitRevision: "c".repeat(40) }));
    const entries = validEntries().map((entry) =>
      entry.path === "preview-metadata.json" ? regular(entry.path, changedMetadata) : entry
    );

    await expectRejectedWithoutOutput(entries, "metadata does not match");
  });

  it("rejects headers controlled by the pull request", async () => {
    const entries = validEntries().map((entry) =>
      entry.path === "_headers"
        ? regular(entry.path, "/*\n  Content-Security-Policy: connect-src *\n")
        : entry
    );

    await expectRejectedWithoutOutput(entries, "headers do not match");
  });
});
