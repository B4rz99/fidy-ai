"""Owned native commands: bound reads, retain bounded output, and settle begun writes."""
import argparse
import os
import signal
import subprocess
import sys
import threading
import time

MAX_OUTPUT = 1024 * 1024


def stop_owned(process):
    """Terminate only the process/session we created, escalating after two seconds."""
    if os.name == 'posix':
        def send(value):
            try:
                os.killpg(process.pid, value)
            except ProcessLookupError:
                pass
            except PermissionError:
                # Some platforms refuse signaling an already-reaped session leader.
                if process.poll() is None:
                    process.send_signal(value)
        send(signal.SIGTERM)
        time.sleep(2)
        send(signal.SIGKILL)
    elif process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
    process.wait()


def run_owned(args, *, cwd=None, writes=False, timeout=120, max_output=MAX_OUTPUT):
    process = subprocess.Popen(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               start_new_session=os.name == 'posix')
    retained = [bytearray(), bytearray()]
    overflow = threading.Event()

    def drain(pipe, index):
        with pipe:
            while True:
                chunk = pipe.read(65536)
                if not chunk:
                    break
                remaining = max_output - len(retained[index])
                retained[index].extend(chunk[:remaining])
                if len(chunk) > remaining:
                    overflow.set()

    threads = [threading.Thread(target=drain, args=(pipe, index))
               for index, pipe in enumerate((process.stdout, process.stderr))]
    for thread in threads:
        thread.start()
    started = time.monotonic()
    refused = False
    try:
        while process.poll() is None or any(thread.is_alive() for thread in threads):
            if not writes and (overflow.is_set() or time.monotonic() - started >= timeout):
                refused = True
                stop_owned(process)
                break
            time.sleep(.01)
        process.wait()
    except BaseException:
        if writes:
            # A local interruption cannot retract a begun publication. Drain it to settlement.
            process.wait()
        else:
            stop_owned(process)
        raise
    finally:
        for thread in threads:
            thread.join()
    if refused or overflow.is_set():
        raise RuntimeError('Command output or execution bound exceeded')
    stdout, stderr = (bytes(value).decode('utf-8', errors='replace') for value in retained)
    if process.returncode:
        raise subprocess.CalledProcessError(process.returncode, args, output=stdout, stderr=stderr)
    return stdout, stderr


if __name__ == '__main__':
    def interrupted(_signal, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser()
    parser.add_argument('--timeout', type=float, default=120)
    parser.add_argument('--max-output', type=int, default=MAX_OUTPUT)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    options = parser.parse_args()
    command = options.command[1:] if options.command[:1] == ['--'] else options.command
    try:
        stdout, stderr = run_owned(command, timeout=options.timeout, max_output=options.max_output)
        sys.stdout.write(stdout)
        sys.stderr.write(stderr)
    except subprocess.CalledProcessError as failure:
        sys.stdout.write(failure.output)
        sys.stderr.write(failure.stderr)
        sys.exit(failure.returncode if failure.returncode > 0 else 1)
    except RuntimeError:
        print('Owned command exceeded its output or execution bound.', file=sys.stderr)
        sys.exit(1)
