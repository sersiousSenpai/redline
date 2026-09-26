// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STATUS_LABEL, type ReleaseStatus } from "./selfDevelop";

// Cross-file laws for Build Redline (docs/self-develop.md).
//
// The feature's decisions are split across two languages on purpose: the
// backend owns every consequential judgement, the frontend owns the sentences
// a person reads at the moment they restart their editor. Nothing checks the
// two agree at build time — a renamed status, a command that never got
// registered, or a readiness rule that drifted produces a panel that looks
// fine and is wrong. These are the rules a future edit could break silently
// and that no unit test on either side would notice.

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const selfDevelopRs = read("src-tauri/src/self_develop.rs");
const activationRs = read("src-tauri/src/activation.rs");
const runtimeProfileRs = read("src-tauri/src/runtime_profile.rs");
const libRs = read("src-tauri/src/lib.rs");
const panel = read("src/components/BuildRedlinePanel.tsx");
const bar = read("src/components/ActivationBar.tsx");
const hook = read("src/hooks/useSelfDevelop.ts");
const buildSh = read("scripts/redline-build.sh");
const installSh = read("scripts/redline.sh");

describe("the release lifecycle is spelled the same in both languages", () => {
  it("every Rust status has a frontend label", () => {
    // `as_str` is the wire form. A status the panel has no label for renders
    // as `undefined` in the one place the user is deciding whether to restart.
    const rustStatuses = [
      ...selfDevelopRs.matchAll(/ReleaseStatus::\w+ => "(\w+)"/g),
    ].map((m) => m[1]);
    expect(rustStatuses.length).toBeGreaterThan(8);
    for (const status of rustStatuses) {
      expect(
        STATUS_LABEL[status as ReleaseStatus],
        `Rust status "${status}" has no frontend label`,
      ).toBeTruthy();
    }
    // ...and nothing in the frontend that the backend cannot produce.
    for (const status of Object.keys(STATUS_LABEL)) {
      expect(rustStatuses, `frontend knows "${status}", Rust does not`).toContain(
        status,
      );
    }
  });

  it("the frontend never offers a restart the backend would refuse", () => {
    // `canOfferRestart` is a mirror, not a second opinion. It must gate on the
    // same four things `Release::is_restartable` plus the manifest's readiness
    // blockers do, or the button appears and the click is rejected.
    const frontend = read("src/lib/selfDevelop.ts");
    for (const clause of [
      'release.status === "ready"',
      "release.bundlePath",
      "release.manifest",
      "checks.every",
      "signing.verified",
      "data.previousCanRead",
      "data.requiresMaintenance",
    ]) {
      expect(frontend, `canOfferRestart lost its "${clause}" guard`).toContain(clause);
    }
    // The Rust side gates on the same facts.
    expect(selfDevelopRs).toContain('self.status() == ReleaseStatus::Ready');
    expect(selfDevelopRs).toContain("self.bundle_path.is_some()");
    expect(selfDevelopRs).toContain("m.is_ready()");
  });
});

describe("every command the frontend calls is registered", () => {
  it("has a Rust command and an invoke_handler entry", () => {
    const invoked = new Set(
      [...`${panel}${bar}${hook}`.matchAll(/invoke<[^>]*>\("([a-z_]+)"|invoke\("([a-z_]+)"/g)].map(
        (m) => m[1] ?? m[2],
      ),
    );
    // The panel and the bar reach the backend for everything consequential;
    // an unregistered name is an invoke that rejects at runtime with
    // "command not found" and nothing at build time.
    expect(invoked.size).toBeGreaterThan(6);
    for (const name of invoked) {
      expect(
        new RegExp(`pub (?:async )?fn ${name}\\b`).test(selfDevelopRs),
        `no Rust command \`${name}\``,
      ).toBe(true);
      expect(libRs, `\`${name}\` is not in invoke_handler`).toContain(
        `self_develop::${name},`,
      );
    }
  });
});

describe("the events the frontend listens for are the ones the backend emits", () => {
  it("matches every activation and release event name", () => {
    const listened = new Set(
      [...`${bar}${hook}`.matchAll(/listen(?:<[^>]*>)?\(\s*"([a-z-]+)"/g)].map((m) => m[1]),
    );
    expect(listened).toContain("activation-quiesce");
    expect(listened).toContain("self-develop-changed");
    const emitters = `${activationRs}${selfDevelopRs}${libRs}`;
    for (const name of listened) {
      expect(emitters, `nothing emits "${name}"`).toContain(`"${name}"`);
    }
  });

  it("the quiesce listener answers, or the restart proceeds without its state", () => {
    // The backend waits a bounded time for this call and then carries on. A
    // listener that never answers does not hang the restart — it silently
    // loses the frontend's layout, which is worse than a visible failure.
    expect(bar).toContain("activation-quiesce");
    expect(bar).toContain("activation_flush_complete");
    expect(activationRs).toContain("FLUSH_TIMEOUT");
  });
});

describe("the isolation the plan depends on", () => {
  it("a probe never installs single-instance, persists storage, or reaches out", () => {
    // Each of these is a separate shared resource that a data-directory change
    // alone would not isolate. Losing any one silently turns a probe into a
    // second production instance.
    expect(libRs).toContain("if profile.single_instance() {");
    expect(libRs).toContain("!runtime_profile::current().persist_webview_storage()");
    expect(libRs).toContain("window.incognito = true");
    expect(libRs).toContain("if activation::background_effects_allowed() {");
    expect(runtimeProfileRs).toContain("PROBE_PORT_RANGE");
  });

  it("preparation refuses to run without demonstrated confinement", () => {
    // The pipeline runs dependency lifecycle scripts and build scripts from the
    // candidate's own source. Without confinement those are arbitrary commands
    // running as the user with the installed application in reach.
    const prepare = selfDevelopRs.slice(selfDevelopRs.indexOf("pub fn prepare("));
    const firstStep = prepare.indexOf("for (index, step) in steps.iter()");
    const qualification = prepare.indexOf("crate::confine::qualification()");
    expect(qualification).toBeGreaterThan(-1);
    expect(qualification).toBeLessThan(firstStep);
    expect(prepare).toContain("will not prepare a release without operating-system confinement");
  });
});

describe("nothing expensive happens after the process exits", () => {
  it("the staging copy and the snapshot are taken before the handoff", () => {
    // The downtime target is only reachable because the expensive parts happen
    // while Redline is still usable. Moving either below the handoff would not
    // break a test — it would just make every restart slow.
    const restart = activationRs.slice(activationRs.indexOf("pub async fn restart_to_apply"));
    const snapshot = restart.indexOf("snapshot_to");
    const staging = restart.indexOf("stage(&candidate");
    const handoff = restart.indexOf("helper_ready");
    const exit = restart.indexOf("app.exit(0)");
    expect(snapshot).toBeGreaterThan(-1);
    expect(snapshot).toBeLessThan(staging);
    expect(staging).toBeLessThan(handoff);
    expect(handoff).toBeLessThan(exit);
  });

  it("the application waits for the helper before it quits", () => {
    // Quitting first and hoping would leave nobody to perform the exchange —
    // and an application that saved its work and shut down for nothing.
    const restart = activationRs.slice(activationRs.indexOf("pub async fn restart_to_apply"));
    expect(restart).toContain("redline_activation::helper_ready(&txn_dir)");
    expect(restart).toContain("did not start, so nothing was changed");
  });
});

describe("preparing and installing are two scripts with one channel between them", () => {
  it("the build script's only stdout is the path, whatever the tools print", () => {
    // `redline.sh` reads the bundle path with `$(...)`. npm, cargo and the
    // Tauri bundler all print progress to stdout, so a script that merely
    // "prints the path at the end" hands the caller an entire build log as a
    // filename — and reports "no application was produced" after a build that
    // succeeded. The whole script's stdout is redirected once; a command added
    // later cannot reintroduce it.
    expect(buildSh).toContain("exec 3>&1 1>&2");
    const emits = [...buildSh.matchAll(/printf\s+'%s\\n'\s+"\$APP_SRC"([^\n]*)/g)];
    expect(emits.length).toBe(1);
    expect(emits[0][1]).toContain(">&3");
  });

  it("the installer never falls back to deleting the installed application", () => {
    // The old path did `rm -rf /Applications/Redline.app` and then copied,
    // which has a window with no Redline on the machine and nothing to go back
    // to. A missing helper must be a refusal, not a reason to do that again.
    expect(installSh).not.toMatch(/rm\s+-rf\s+\/Applications/);
    expect(installSh).toContain('"$HELPER" install "$APP_SRC" /Applications/Redline.app');
    expect(installSh).toContain("refusing to install by deleting");
  });

  it("the helper and the identity stamp go in before the bundle is signed", () => {
    // Both are inside what the signature covers. Added afterwards, the bundle
    // no longer verifies — and `--verify --strict` is what the restart path
    // checks before it will install anything.
    const helper = buildSh.indexOf('cp src-tauri/target/release/redline-activate');
    const stamp = buildSh.indexOf('redline-release.json');
    const sign = buildSh.indexOf('Signing the bundle');
    const verify = buildSh.indexOf('codesign --verify --strict');
    expect(helper).toBeGreaterThan(-1);
    expect(helper).toBeLessThan(sign);
    expect(stamp).toBeLessThan(sign);
    expect(sign).toBeLessThan(verify);
  });
});
