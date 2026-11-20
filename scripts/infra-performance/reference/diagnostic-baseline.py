"""Create the reference-only D1 preview alongside its byte-verified original fixture."""
from pathlib import Path
from shutil import copyfile

root = Path("baseline-d1/apps/server/cloudflare")
copyfile(Path(__file__).with_name("pressure-probe.mjs"), root / "pressure-probe.mjs")
preview = (root / "browser-acceptance-preview.ts").read_text()
marker = ".then(bridgeBrowserOrigin)"
assert preview.count(marker) == 1
(root / "diagnostic-browser-preview.ts").write_text(
    'import { recordPressure } from "./pressure-probe.mjs";\n' + preview.replace(
        marker,
        marker + "\n      .then((response) => recordPressure(request, response, started, (query, user, now) => db.prepare(query).bind(user, now).first()))"
    )
)
