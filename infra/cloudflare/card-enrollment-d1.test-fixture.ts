// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";

/** Isolated D1 fixture with the production CardEnrollment migration and caller-owned auth tables. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const makeCardEnrollmentD1 = async (
  name: string,
  authSchema: ReadonlyArray<string>
): Promise<Readonly<{ db: D1Database; instance: Miniflare }>> => {
  const instance = new Miniflare({
    workers: [
      {
        config: {
          compatibilityDate: "2026-09-08",
          env: { DB: { id: name, type: "d1" } },
          manifest: {
            mainModule: "index.mjs",
            modules: {
              "index.mjs": {
                contents: "export default {fetch() {return new Response('ok')}}",
                type: "esm",
              },
            },
          },
          name,
          type: "worker",
        },
      },
    ],
  });
  await instance.ready;
  const db = await instance.getD1Database("DB");
  await db.batch(authSchema.map((statement) => db.prepare(statement)));
  const migration = await readFile(
    new URL("./migrations/0009_card_enrollment.sql", import.meta.url),
    "utf8"
  );
  await migration
    .replace(/^--.*$/gmu, "")
    .trim()
    .split(/;\s*\n(?=CREATE |$)/u)
    .reduce<Promise<void>>(
      (previous, statement) =>
        previous.then(() => db.prepare(statement).run()).then(() => undefined),
      Promise.resolve()
    );
  return { db, instance };
};
