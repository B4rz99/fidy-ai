import hashlib
import io
import json
import unittest
import zipfile
from unittest.mock import patch
from fallback_stage import load_stage
from qualified_release import REPO


class SealedFallback(unittest.TestCase):
    def setUp(self):
        self.revision = "a" * 40
        self.stage = {"revision": self.revision}
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w") as archive:
            archive.writestr("native-fallback-stage.json", json.dumps(self.stage))
        self.data = data.getvalue()
        self.digest = hashlib.sha256(self.data).hexdigest()
        repo = {"full_name": REPO}
        self.run = {"id": 12, "repository": repo, "head_repository": repo,
                    "path": ".github/workflows/native-storage-release.yml", "head_branch": "trunk",
                    "head_sha": self.revision, "event": "workflow_dispatch", "run_attempt": 1,
                    "conclusion": "failure"}
        self.meta = {"id": 34, "workflow_run": {"id": 12, "head_sha": self.revision}, "expired": False,
                     "name": "native-fixture-fallback-12", "size_in_bytes": len(self.data),
                     "digest": "sha256:" + self.digest}
        self.step = {"name": "Seal dormant fallback stage before promotion", "conclusion": "success"}
        self.jobs = {"total_count": 1, "jobs": [{"name": "release", "steps": [self.step]}]}

    def get(self, path):
        if path == "artifacts/34/zip":
            return self.data
        return json.dumps({"runs/12": self.run, "artifacts/34": self.meta,
                           "runs/12/attempts/1/jobs?per_page=100": self.jobs}[path]).encode()

    def load(self):
        return load_stage(self.revision, "34", self.digest, self.get)

    def test_sealed_stage_survives_failure_after_upload(self):
        self.assertEqual(self.load(), self.stage)

    def test_refuses_unsealed_or_foreign_source_and_changed_bytes(self):
        for record, changes in ((self.step, {"conclusion": "skipped"}),
                               (self.run, {"run_attempt": 2}), (self.run, {"head_branch": "scratch"}),
                               (self.meta, {"name": "native-storage-release-12"}),
                               (self.meta, {"expired": True}), (self.jobs, {"total_count": 2})):
            with self.subTest(changes=changes), patch.dict(record, changes), self.assertRaises(ValueError):
                self.load()
        self.data += b"extra"
        with self.assertRaises(ValueError):
            self.load()
