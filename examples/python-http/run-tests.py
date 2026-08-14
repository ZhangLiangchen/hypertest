#!/usr/bin/env python3
"""Start the fixture, execute generated pytest tests, and emit coverage JSON."""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def wait_until_ready(timeout: float = 8.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", 8765), timeout=0.2):
                return
        except OSError:
            time.sleep(0.05)
    raise RuntimeError("HTTP fixture did not become ready")


def main() -> int:
    environment = {**os.environ, "HYPERTEST_BASE_URL": "http://127.0.0.1:8765"}
    server = subprocess.Popen(
        [sys.executable, "app.py"],
        cwd=ROOT,
        env=environment,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        wait_until_ready()
        command = [
            sys.executable,
            "-m",
            "coverage",
            "run",
            "--branch",
            "-m",
            "pytest",
            "-q",
            "--junitxml=.hypertest-junit.xml",
            "tests",
        ]
        result = subprocess.run(command, cwd=ROOT, env=environment, check=False)
        subprocess.run(
            [sys.executable, "-m", "coverage", "json", "-o", ".coverage.json"],
            cwd=ROOT,
            env=environment,
            check=False,
            stdout=subprocess.DEVNULL,
        )
        return result.returncode
    finally:
        server.terminate()
        try:
            server.wait(timeout=3)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=3)
        if server.returncode not in {0, -15, -9} and server.stderr is not None:
            sys.stderr.write(server.stderr.read())


if __name__ == "__main__":
    raise SystemExit(main())
