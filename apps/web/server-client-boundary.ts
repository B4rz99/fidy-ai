import type { Plugin } from "vite";

const serverSourceRoot = Bun.fileURLToPath(new URL("../server/src/", import.meta.url));

const webSourceRoot = Bun.fileURLToPath(new URL("./src/", import.meta.url));

export const serverClientBoundary = (): Plugin => ({
  name: "server-client-boundary",
  enforce: "pre",
  resolveId(source, importer) {
    if (!source.startsWith("~/")) return null;

    if (importer === undefined || importer.startsWith(webSourceRoot)) {
      throw new Error(`Web modules cannot import server-private path ${source}`);
    }

    const target = `${serverSourceRoot}${source.slice(2)}`;

    return this.resolve(target, importer, { skipSelf: true });
  },
});
