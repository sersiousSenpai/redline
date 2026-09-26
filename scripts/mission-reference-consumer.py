#!/usr/bin/env python3
"""Headless mission adapter: verify a bundle, or return attributed fixture findings.

Uses only Python's standard library and the existing Redline daemon. It never
creates credentials, confirms a user judgment, schedules a fleet, or trains a
model. --run is an explicit, bounded simulated run against a real mission bot.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def verify_manifest(context, selected_assets=None):
    if context.get("schema") != 1 or context["missionId"] != context["workspaceId"]:
        raise ValueError("unsupported schema or mismatched mission workspace")
    manifest = copy.deepcopy(context)
    manifest["manifestHash"] = ""
    for asset in manifest["assets"].values():
        asset["content"] = None
    if digest(manifest) != context["manifestHash"]:
        raise ValueError("manifest digest mismatch")
    assets = context["assets"] if selected_assets is None else selected_assets
    for name, asset in assets.items():
        expected = context["assets"].get(name)
        if expected is None or expected["hash"] != asset["hash"]:
            raise ValueError(f"uncommitted asset: {name}")
        if asset["status"] == "available":
            if asset["content"] is None or digest(asset["content"]) != asset["hash"]:
                raise ValueError(f"asset digest mismatch: {name}")
        elif asset["status"] not in ("omitted", "expired", "redacted") or asset["content"] is not None:
            raise ValueError(f"invalid asset availability: {name}")
    return {"verified": True, "versionId": context["versionId"], "assets": sorted(assets)}


class RedlineContext:
    def __init__(self, mission_id, base_url, token):
        self.mission_id = mission_id
        self.base_url = base_url.rstrip("/")
        self.token = token

    def call(self, op, **fields):
        data = canonical({"missionId": self.mission_id, "workspaceId": self.mission_id, "op": op, **fields})
        request = urllib.request.Request(
            f"{self.base_url}/v1/missions/{self.mission_id}/foundation", data=data,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.token}"}, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"{op} failed ({error.code}): {error.read(8192).decode('utf-8', 'replace')}") from error


def run_fixture(args):
    fixture = json.loads(Path(args.fixture).read_text())
    token = os.environ.get("REDLINE_DAEMON_TOKEN", "")
    if not token:
        raise ValueError("REDLINE_DAEMON_TOKEN is required for an attributed runtime write")
    client = RedlineContext(args.mission, args.base_url, token)
    identity = fixture["identity"]
    identity["execution"]["workspaceId"] = args.mission
    run = client.call("startRun", botId=args.bot, idempotencyKey=args.run_key, identity=identity)
    verified = verify_manifest(run["contextManifest"], run["contextAssets"])
    if set(verified["assets"]) - set(run["contextScope"]):
        raise ValueError("runtime received context outside its reviewed scope")
    if run["status"] in ("completed", "partial", "failed", "cancelled"):
        return {"runId": run["id"], "status": run["status"], "replayed": False, "context": verified}
    results = []
    for index, finding in enumerate(fixture["findings"]):
        result = client.call("ingestFinding", runId=run["id"], finding=finding)
        results.append(result)
        client.call("checkpointRun", runId=run["id"], checkpoint={
            "sourceIndex": index + 1, "seenFingerprints": [f["fingerprint"] for f in fixture["findings"][:index + 1]],
            "adapter": "securities-fixture-v1"})
    coverage = fixture["coverage"]
    status = "partial" if coverage.get("failedSources") else "completed"
    completed = client.call("finishRun", runId=run["id"], status=status, coverage=coverage)
    return {"runId": run["id"], "status": completed["status"], "context": verified, "ingestion": results,
            "simulation": "Fixture observations, not current legal or market information"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", metavar="BUNDLE", help="Verify an exported mission context without desktop access")
    parser.add_argument("--run", action="store_true", help="Return simulated fixture findings through a real bot run")
    parser.add_argument("--mission")
    parser.add_argument("--bot")
    parser.add_argument("--run-key", default="securities-fixture-day-one")
    parser.add_argument("--base-url", default="http://127.0.0.1:7676")
    parser.add_argument("--fixture", default=str(Path(__file__).resolve().parents[1] / "fixtures/mission/securities-dev.json"))
    args = parser.parse_args()
    try:
        if args.verify:
            data = json.loads(Path(args.verify).read_text())
            result = verify_manifest(data.get("context", data))
        elif args.run and args.mission and args.bot:
            result = run_fixture(args)
        else:
            parser.error("choose --verify BUNDLE or --run --mission ID --bot ID")
        print(json.dumps(result, indent=2))
    except (ValueError, RuntimeError, OSError, KeyError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
