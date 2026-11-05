/** Wrangler remote bindings require Node's dispatcher; keep the repository command convenient without running operator code under Bun. */
const built = await Bun.build({
  entrypoints: [`${import.meta.dir}/main.ts`],
  outdir: `${import.meta.dir}/../../dist/pro`,
  naming: "[name]-[hash].mjs",
  target: "node",
  packages: "external",
});
const output = built.outputs[0];
if (!built.success || output === undefined) {
  process.stderr.write("No se pudo preparar la herramienta de operador.\n");
  process.exitCode = 1;
} else {
  const command = Bun.spawn(["node", output.path, ...process.argv.slice(2)], {
    env: { ...Bun.env, WRANGLER_LOG: "error" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await command.exited;
}
