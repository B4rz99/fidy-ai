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
    args = parser.parse_args()
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
        inspection_ids = sorted(observed["inspections"])
        (out / "expected.json").write_text(json.dumps({"history": observed["history"], "inspections": observed["inspections"]}, ensure_ascii=False))
    artifacts["plan"] = hashlib.sha256((out / "plan.json").read_bytes()).hexdigest()
    (out / "manifest.json").write_text(json.dumps(dict(baseline=PIN, calibration=CALIBRATION, sha256=artifacts), indent=2))
    disclosure = subprocess.check_output(["bun", "-e",
        'import {currentDisclosureFor} from "./apps/server/src/shell/consent/operations"; process.stdout.write(JSON.stringify(currentDisclosureFor()))'], cwd=root)
    (out / "disclosure.json").write_bytes(disclosure)
    (out / "private-ingress.mjs").write_bytes((HERE / "private-ingress.mjs").read_bytes())
    (out / "ingress-entry.mjs").write_text(
        'import ingress from "./public-worker.mjs";\n'
        'import { privateIngress } from "./private-ingress.mjs";\n'
        f'export default privateIngress(ingress, {json.dumps(inspection_ids)});\n')
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
            limits["GET /transactions?limit=25"]["maximum"] = {"rowsRead": 0, "rowsWritten": 0}
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
    (out / "manifest.json").write_text(json.dumps(dict(baseline=PIN, calibration=CALIBRATION, sha256=artifacts), indent=2))


if __name__ == "__main__":
    main()
