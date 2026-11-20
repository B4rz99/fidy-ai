import json
from pathlib import Path
import sys
root=Path(sys.argv[1])
original=json.loads((root/"original.json").read_bytes())["passes"][0]
candidate=json.loads((root/"candidate.json").read_bytes())["passes"]
tracked=(root/"original.inputs").read_bytes()==(root/"candidate.inputs").read_bytes()
def comparison(other):
    a,b=original["files"],other["files"]
    return dict(added=sorted(b.keys()-a.keys()), removed=sorted(a.keys()-b.keys()),
                changed=sorted(p for p in a.keys()&b.keys() if a[p]!=b[p]), count=len(b),
                inputEqual=original["receipt"]["hash"]["input"]==other["receipt"]["hash"]["input"],
                outputEqual=original["receipt"]["hash"]["output"]==other["receipt"]["hash"]["output"],
                absent=other["absent"],afterBuild=other["afterAgainstOriginal"])
report=dict(trackedWebAndLockfileEqual=tracked, originalFiles=len(original["files"]),original=original["receipt"],
            candidates=[comparison(p) for p in candidate], repeatedCandidateManifestEqual=candidate[0]["files"]==candidate[1]["files"])
(root/"comparison.json").write_text(json.dumps(report,indent=2))
print(json.dumps(report))
assert tracked and report["repeatedCandidateManifestEqual"] and len(candidate)==2
assert all(not (r["added"] or r["removed"] or r["changed"]) and r["inputEqual"] and r["outputEqual"] and r["absent"]=="update" and r["afterBuild"]=="noop" for r in report["candidates"])
