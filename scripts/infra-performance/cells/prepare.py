"""Build the immutable comparator Worker modules and the calibrated private SQL fixture offline."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

PIN = "fb53d9e755c14393048dc945fc0b7f117730d872"
CALIBRATION = "15cfe773cd263b6a3d4e1b6e1b958f233cdde84f"
HERE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--d1", type=Path, required=True)
    parser.add_argument("--calibration", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    root, source, out = (p.resolve() for p in (args.d1, args.calibration, args.out))
    for path, revision in ((root, PIN), (source, CALIBRATION)):
        if subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=path, text=True).strip() != revision:
            raise ValueError("Unexpected source revision")
    out.mkdir(parents=True, exist_ok=False)
    artifacts = {}
    for name in ("public-worker", "core-worker"):
        entry = f"apps/server/cloudflare/{name}.ts"
        destination = out / (name + ".mjs")
        subprocess.run(["bun", "build", "--target=browser", "--external=cloudflare:workers", "--external=node:*",
                        entry, "--outfile", str(destination)], cwd=root, check=True)
        artifacts[name] = hashlib.sha256(destination.read_bytes()).hexdigest()

    # Restore only test instrumentation. Every application module and SQL migration comes from PIN.
    for name in ("apps/server/cloudflare/browser-assessment.test-fixture.ts", "apps/server/cloudflare/d1-test-fixture.ts",
                 "apps/server/scripts/prepare-d1-calibration.ts"):
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(subprocess.check_output(["git", "show", f"HEAD:{name}"], cwd=source))
    subprocess.run(["bun", "apps/server/scripts/prepare-d1-calibration.ts", str(out / "plan.json")], cwd=root, check=True)
    artifacts["plan"] = hashlib.sha256((out / "plan.json").read_bytes()).hexdigest()
    (out / "manifest.json").write_text(json.dumps(dict(baseline=PIN, calibration=CALIBRATION, sha256=artifacts), indent=2))
    (out / "meter.mjs").write_bytes((HERE / "meter.mjs").read_bytes())
    (out / "limits.json").write_text("null")
    for mode in ("train", "bounded"):
        subprocess.run(["bun", "build", "meter.mjs", "--target=browser", "--external=cloudflare:workers", "--external=node:*",
                        "--outfile", "metered-core.mjs"], cwd=out, check=True)
        subprocess.run(["bun", str(HERE / "probe.mjs"), str(out), mode], cwd=root, check=True)
    artifacts["metered-core"] = hashlib.sha256((out / "metered-core.mjs").read_bytes()).hexdigest()
    artifacts["limits"] = hashlib.sha256((out / "limits.json").read_bytes()).hexdigest()
    (out / "manifest.json").write_text(json.dumps(dict(baseline=PIN, calibration=CALIBRATION, sha256=artifacts), indent=2))


if __name__ == "__main__":
    main()
