"""Invoke after the trusted Bun workspace has been installed."""
import os
from pathlib import Path
import subprocess
import unittest


class BridgeEntrypointTests(unittest.TestCase):
    def test_direct_bridge_declines_before_reading_credentials_or_accessing_network(self):
        directory = Path(__file__).resolve().parent
        env = {k:v for k,v in os.environ.items() if k not in ("SMOKE_PROOF","FIDY_NATIVE_REVISION")}
        result = subprocess.run(["bun", str(directory / "bridge.ts"), "hosted"], env=env,
                                capture_output=True, text=True, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr.strip(), "Native fixture bridge admits offline verification only")


if __name__ == "__main__":
    unittest.main()
