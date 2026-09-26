#!/usr/bin/env python3
"""Measure synthetic capture tests without including Cargo or compilation.

This runs an already-built Rust test binary. It never captures a live screen,
enables capture, edits settings, or opens the application's database.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import time


def measure(binary, test, mode, batch, output, iterations):
    name = f"{mode}-{batch}"
    environment = dict(os.environ)
    environment["REDLINE_OCR_BENCH_MODE"] = mode
    environment["REDLINE_OCR_BENCH_ITERATIONS"] = str(iterations)
    command = ["/usr/bin/time", "-l", str(binary), test, "--exact", "--ignored", "--nocapture", "--test-threads=1"]
    started = time.monotonic()
    process = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=600)
    wall_seconds = time.monotonic() - started
    (output / f"{name}.stdout.log").write_text(process.stdout)
    (output / f"{name}.stderr.log").write_text(process.stderr)
    timing = re.search(r"([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys", process.stderr)
    rss = re.search(r"(\d+)\s+maximum resident set size", process.stderr)
    payloads = []
    for line in process.stdout.splitlines():
        start = line.find("{")
        if start >= 0:
            try:
                payloads.append(json.loads(line[start:]))
            except json.JSONDecodeError:
                pass
    interface = re.search(
        r"capture interface only, (\d+) samples: "
        r"disabled p50=(\d+)us p75=(\d+)us p95=(\d+)us; "
        r"enabled admission\+persist\+FTS p50=(\d+)us p75=(\d+)us p95=(\d+)us; "
        r"simulated_pixel_bytes=(\d+); sqlite_allocation_before=(\d+); sqlite_allocation_after=(\d+)",
        process.stdout,
    )
    if mode == "interface" and interface:
        fields = ["samplesPerMode", "disabledP50Us", "disabledP75Us", "disabledP95Us",
                  "enabledP50Us", "enabledP75Us", "enabledP95Us", "simulatedPixelBytes",
                  "sqliteAllocationBeforeBytes", "sqliteAllocationAfterBytes"]
        payload = dict(zip(fields, map(int, interface.groups())))
        payload["sqliteAllocationDeltaBytes"] = payload["sqliteAllocationAfterBytes"] - payload["sqliteAllocationBeforeBytes"]
        payload["notMeasured"] = ["native screenshot", "OCR", "real media storage", "UI latency"]
        payloads.append(payload)
    return {
        "mode": mode, "batch": batch, "test": test, "command": command,
        "exitCode": process.returncode, "runnerWallSeconds": wall_seconds,
        "processRealSeconds": float(timing[1]) if timing else None,
        "processUserSeconds": float(timing[2]) if timing else None,
        "processSystemSeconds": float(timing[3]) if timing else None,
        "maximumResidentSetBytes": int(rss[1]) if rss else None,
        "payloads": payloads,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--test-binary", type=Path, required=True)
    parser.add_argument("--ocr-test", default="capture_ocr::tests::ocr_fixture_microbenchmark")
    parser.add_argument("--interface-test", default="mission_context::tests::capture_interface_microbenchmark")
    parser.add_argument("--batches", type=int, default=3)
    parser.add_argument("--iterations", type=int, default=100)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    binary = args.test_binary.resolve()
    if not binary.is_file() or "deps" not in binary.parts:
        parser.error("use the confirmed test executable from Cargo's target/.../deps directory")
    if not 1 <= args.iterations <= 100 or not 1 <= args.batches <= 10:
        parser.error("iterations must be 1–100 and batches 1–10")
    if args.output_dir.exists():
        parser.error("output directory must be new so earlier measurements remain intact")
    args.output_dir.mkdir(parents=True)
    listing = subprocess.run([str(binary), "--list"], capture_output=True, text=True, timeout=30, check=True).stdout
    for test in [args.ocr_test, args.interface_test]:
        if f"{test}: test" not in listing:
            parser.error(f"the binary does not contain {test}; compile the current modules first")
    report = {
        "testBinary": str(binary), "profile": "debug" if "debug" in binary.parts else "release",
        "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "platform": {"system": platform.system(), "version": platform.mac_ver()[0], "architecture": platform.machine()},
        "iterations": args.iterations, "batches": args.batches,
        "notes": "Synthetic PNG OCR and in-memory admission/index tests only; no live capture or UI latency. Darwin RSS is process peak bytes, including the test harness and framework initialization.",
        "runs": [],
    }
    for batch in range(1, args.batches + 1):
        for mode, test in [("disabled", args.ocr_test), ("enabled", args.ocr_test), ("interface", args.interface_test)]:
            result = measure(binary, test, mode, batch, args.output_dir, args.iterations)
            report["runs"].append(result)
            (args.output_dir / "results.json").write_text(json.dumps(report, indent=2) + "\n")
            print(json.dumps(result), flush=True)
            if result["exitCode"] != 0:
                raise SystemExit(result["exitCode"])
            if not result["payloads"] or result["maximumResidentSetBytes"] is None or result["processRealSeconds"] is None:
                raise SystemExit("Benchmark output was incomplete or its format changed; see the preserved logs")
            if any(isinstance(payload, dict) and (payload.get("errors", 0) != 0 or payload.get("coldSucceeded") is False) for payload in result["payloads"]):
                raise SystemExit("OCR benchmark reported recognition errors; see the preserved results")


if __name__ == "__main__":
    main()
