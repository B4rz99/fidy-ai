"""Build the immutable comparator Worker modules and the calibrated private SQL fixture offline."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

PIN = "fb53d9e755c14393048dc945fc0b7f117730d872"
CALIBRATION = "15cfe773cd263b6a3d4e1b6e1b958f233cdde84f"
HERE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--d1", type=Path, required=True)
    parser.add_argument("--calibration", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--canonical-fixture", type=Path, help="Originals and actual private provenance from the disposable native rehearsal")
    parser.add_argument("--snapshot", action="store_true", help="Reconstruct and check the final empty D1 schema against frozen migration replay")
    parser.add_argument("--materialized", action="store_true", help="Import the complete private pre-Login canonical fixture and verify its full state")
    parser.add_argument("--browser-workspace", action="store_true", help="Prepare the signed eight-original Transactions browser profile")
    args = parser.parse_args()
    if args.browser_workspace and not args.materialized:
        parser.error("--browser-workspace requires --materialized")
    if args.materialized and (not args.canonical_fixture or args.snapshot):
        parser.error("--materialized needs --canonical-fixture and selects its own snapshot mode")
    root, source, out = (p.resolve() for p in (args.d1, args.calibration, args.out))
    for path, revision in ((root, PIN), (source, CALIBRATION)):
        if subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=path, text=True).strip() != revision:
            raise ValueError("Unexpected source revision")
    reviewed = {"apps/server/cloudflare/" + name for name in ("browser-assessment.test-fixture.ts", "browser-acceptance-preview.ts",
                                                            "browser-acceptance-seed.ts")}
    changed = subprocess.check_output(["git", "diff", "HEAD", "--name-only"], cwd=root, text=True).splitlines()
    if set(changed) - reviewed:
        raise ValueError("Frozen application has tracked source changes")
    out.mkdir(parents=True, exist_ok=False)
    artifacts = {}
    for name in ("public-worker", "core-worker"):
        entry = f"apps/server/cloudflare/{name}.ts"
        destination = out / (name + ".mjs")
        subprocess.run(["bun", "build", "--target=browser", "--external=cloudflare:workers", "--external=node:*",
                        entry, "--outfile", str(destination)], cwd=root, check=True)
        artifacts[name] = hashlib.sha256(destination.read_bytes()).hexdigest()

    # Restore only test instrumentation. Every application module and SQL migration comes from PIN.
    originals = {}
    try:
        for name in ("apps/server/cloudflare/browser-assessment.test-fixture.ts", "apps/server/cloudflare/d1-test-fixture.ts",
                     "apps/server/scripts/prepare-d1-calibration.ts"):
            target = root / name
            originals[target] = target.read_bytes() if target.exists() else None
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(subprocess.check_output(["git", "show", f"HEAD:{name}"], cwd=source))
        subprocess.run(["bun", "apps/server/scripts/prepare-d1-calibration.ts", str(out / "plan.json")], cwd=root, check=True)
    finally:
        for path, original in originals.items():
            if original is None:
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(original)
    inspection_ids = []
    if args.canonical_fixture:
        sys.path.insert(0, str(HERE.parent / "canonical-fixture"))
        from mirror import materialize
        observed = materialize(out / "plan.json", args.canonical_fixture)
        if args.browser_workspace != ("workspace" in observed):
            raise ValueError("Signed workspace and requested comparator workload differ")
        inspection_ids = sorted(observed["inspections"])
        (out / "expected.json").write_text(json.dumps({"history": observed["history"], "inspections": observed["inspections"], **({"workspace": observed["workspace"]} if args.browser_workspace else {})}, ensure_ascii=False))
    if args.snapshot or args.materialized:
        # Use the same package and migration registry as the frozen Alchemy D1 provider.
        # Only the executor is directed to the private local workerd binding.
        migration_module = root / "node_modules/alchemy/src/SQL/Migrations"
        path_literal = lambda path: json.dumps(str(path))
        entry = out / "derive-snapshot.mjs"
        entry.write_text(
            'import { Effect } from "effect";\n'
            'import { BunServices } from "@effect/platform-bun";\n'
            + 'import { applyAlchemyFormat, ALCHEMY_DEFAULT_TABLE } from ' + path_literal(migration_module / "AlchemyFormat.ts") + ';\n'
            + 'import { readFlatRecords } from ' + path_literal(migration_module / "Records.ts") + ';\n'
            + 'import { snapshotRuntime } from ' + path_literal(HERE / "snapshot-runtime.mjs") + ';\n'
            + 'const db = await snapshotRuntime.getD1Database("ORACLE");\n'
            + 'const records = await Effect.runPromise(readFlatRecords(' + path_literal(root / "apps/server/cloudflare/migrations")
            + ').pipe(Effect.provide(BunServices.layer)));\n'
            + 'const executor = {dialect:"sqlite",query:(sql,params=[])=>Effect.tryPromise(async ()=>(await db.prepare(sql).bind(...params).all()).results),'
            + 'batch:statements=>Effect.tryPromise(async()=>{await db.batch(statements.map(sql=>db.prepare(sql)));})};\n'
            + 'await Effect.runPromise(applyAlchemyFormat({executor,records,table:ALCHEMY_DEFAULT_TABLE}));\n'
            + 'await import(' + path_literal(HERE / "snapshot.mjs") + ');\n')
        (out / "snapshot-proof.json").write_text(json.dumps({"stage":"replay-frozen-alchemy","baseline":PIN}))
        subprocess.run(["bun", str(entry), str(out), "materialized" if args.materialized else "empty", "browser" if args.browser_workspace else "original"], cwd=root, check=True)

    artifacts["plan"] = hashlib.sha256((out / "plan.json").read_bytes()).hexdigest()
    (out / "manifest.json").write_text(json.dumps(dict(baseline=PIN, calibration=CALIBRATION, sha256=artifacts), indent=2))
    disclosure = subprocess.check_output(["bun", "-e",
        'import {currentDisclosureFor} from "./apps/server/src/shell/consent/operations"; process.stdout.write(JSON.stringify(currentDisclosureFor()))'], cwd=root)
    (out / "disclosure.json").write_bytes(disclosure)
    (out / "private-ingress.mjs").write_bytes((HERE / "private-ingress.mjs").read_bytes())
    (out / "ingress-entry.mjs").write_text(
        'import ingress from "./public-worker.mjs";\n'
        'import { privateIngress } from "./private-ingress.mjs";\n'
        f'export default privateIngress(ingress, {json.dumps(inspection_ids)}, {json.dumps(args.browser_workspace)});\n')
    (out / "core-entry.mjs").write_text(
        'import core, { UserTransactionCoordinator as Coordinator } from "./core-worker.mjs";\n'
        'import { meteredCore } from "./meter.mjs";\n'
        'import { training, limits } from "./configured-limits.mjs";\n'
        'const { worker, UserTransactionCoordinator } = meteredCore(core, Coordinator, { training, limits });\n'
        'export { worker as default, UserTransactionCoordinator };\n')
    subprocess.run(["bun", "build", "ingress-entry.mjs", "--target=browser", "--external=cloudflare:workers", "--external=node:*",
                    "--outfile", "bounded-ingress.mjs"], cwd=out, check=True)
    (out / "meter.mjs").write_bytes((HERE / "meter.mjs").read_bytes())
    (out / "limits.json").write_text("null")
    for mode in ("train", "refuse", "bounded"):
        limits = {} if mode == "train" else json.loads((out / "limits.json").read_text())
        if mode == "refuse":
            limits["GET /web/session/binding?context=transactions" if args.browser_workspace else "GET /transactions?limit=25"]["maximum"] = {"rowsRead": 0, "rowsWritten": 0}
        (out / "configured-limits.mjs").write_text("export const training = " + json.dumps(mode == "train")
                                                 + "; export const limits = " + json.dumps(limits) + ";")
        subprocess.run(["bun", "build", "core-entry.mjs", "--target=browser", "--external=cloudflare:workers", "--external=node:*",
                        "--outfile", "metered-core.mjs"], cwd=out, check=True)
        subprocess.run(["bun", str(HERE / "probe.mjs"), str(out), mode], cwd=root, check=True)
    reference = json.loads((out.parent / "attempts.json").read_bytes()) if (out.parent / "attempts.json").exists() else []
    probe = json.loads((out / "probe.json").read_bytes())
    if not args.canonical_fixture and any(not row["ok"] or row["digest"] != probe["responseSha256"] for row in reference):
        raise ValueError("Frozen Worker graph and paired reference returned different response bytes")
    artifacts["metered-core"] = hashlib.sha256((out / "metered-core.mjs").read_bytes()).hexdigest()
    artifacts["bounded-ingress"] = hashlib.sha256((out / "bounded-ingress.mjs").read_bytes()).hexdigest()
    artifacts["limits"] = hashlib.sha256((out / "limits.json").read_bytes()).hexdigest()
    artifacts["probe"] = hashlib.sha256((out / "probe.json").read_bytes()).hexdigest()
    for name in ("snapshot-proof", "expected", "disclosure"):
        path = out / (name + ".json")
        if path.is_file():
            artifacts[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    contract = subprocess.check_output(["bun", "run", "--silent", "--cwd", "apps/server", "contracts:digest"], cwd=root, text=True).strip()
    (out / "manifest.json").write_text(json.dumps(dict(baseline=PIN, calibration=CALIBRATION, contractDigest=contract, sha256=artifacts), indent=2))


if __name__ == "__main__":
    main()
