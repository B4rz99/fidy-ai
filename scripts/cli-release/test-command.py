"""Exercise native output bounds, read cancellation and begun publication settlement."""
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from command import run_owned


class CommandTests(unittest.TestCase):
    def test_overflow_stops_a_read_that_refuses_term(self):
        started = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, 'bound exceeded'):
            run_owned([sys.executable, '-c',
                       'import signal,sys,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); '
                       'sys.stdout.write("x"*131072);sys.stdout.flush();time.sleep(30)'],
                      timeout=5, max_output=1024)
        self.assertLess(time.monotonic() - started, 4)

    @unittest.skipUnless(sys.platform != 'win32', 'Owned POSIX process-group behavior')
    def test_escalation_stops_descendant_work_as_well_as_parent(self):
        with tempfile.TemporaryDirectory() as directory:
            heartbeat = Path(directory) / 'heartbeat'
            descendant = ('import pathlib,signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);'
                          'p=pathlib.Path(__import__("sys").argv[1]);'
                          '\nwhile True:p.write_text(str(time.monotonic()));time.sleep(.02)')
            parent = ('import pathlib,subprocess,sys,time;'
                      'subprocess.Popen([sys.executable,"-c",sys.argv[1],sys.argv[2]]);'
                      '\nwhile not pathlib.Path(sys.argv[2]).exists():time.sleep(.01)'
                      '\nsys.stdout.write("x"*131072);sys.stdout.flush();time.sleep(30)')
            with self.assertRaisesRegex(RuntimeError, 'bound exceeded'):
                run_owned([sys.executable, '-c', parent, descendant, str(heartbeat)],
                          timeout=5, max_output=1024)
            settled = heartbeat.read_text()
            time.sleep(.1)
            self.assertEqual(heartbeat.read_text(), settled)

    def test_read_deadline_reaps_owned_process(self):
        with self.assertRaisesRegex(RuntimeError, 'bound exceeded'):
            run_owned([sys.executable, '-c', 'import time;time.sleep(30)'], timeout=.05)

    def test_begun_write_settles_after_deadline_and_overflow(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'committed'
            with self.assertRaisesRegex(RuntimeError, 'bound exceeded'):
                run_owned([sys.executable, '-c',
                           'import sys,time,pathlib;sys.stdout.write("x"*131072);sys.stdout.flush();'
                           'time.sleep(.1);pathlib.Path(sys.argv[1]).write_text("settled")', str(marker)],
                          writes=True, timeout=.01, max_output=1024)
            self.assertEqual(marker.read_text(), 'settled')

    def test_retains_bounded_http404_evidence_for_reconciliation(self):
        with self.assertRaises(subprocess.CalledProcessError) as raised:
            run_owned([sys.executable, '-c',
                       'import sys;print("HTTP 404",file=sys.stderr);sys.exit(1)'])
        self.assertEqual(raised.exception.stderr, 'HTTP 404\n')


if __name__ == '__main__':
    unittest.main()
