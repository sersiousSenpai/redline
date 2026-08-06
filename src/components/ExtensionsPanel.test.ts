// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatBytes,
  installAction,
  isToggleable,
  statusChip,
  type ExtensionInfo,
} from "./ExtensionsPanel";

const info = (over: Partial<ExtensionInfo>): ExtensionInfo => ({
  name: "x",
  version: null,
  kind: "wasm",
  scopes: [],
  events: [],
  status: "running",
  detail: null,
  strikes: 0,
  panel: null,
  dir: "/tmp/x",
  ...over,
});

describe("statusChip", () => {
  it("maps every host status onto a themed chip", () => {
    expect(statusChip(info({ status: "running" }))).toEqual({
      label: "running",
      color: "var(--color-success)",
    });
    expect(statusChip(info({ status: "failed" })).color).toBe(
      "var(--color-danger)",
    );
    expect(statusChip(info({ status: "external" })).label).toBe(
      "external process",
    );
    expect(statusChip(info({ status: "disabled" })).label).toBe("disabled");
  });

  it("passes an unknown future status through instead of crashing", () => {
    expect(statusChip(info({ status: "hibernating" })).label).toBe(
      "hibernating",
    );
  });
});

describe("isToggleable", () => {
  it("only the host-run kind gets the enable/disable toggle", () => {
    expect(isToggleable(info({ kind: "wasm" }))).toBe(true);
    expect(isToggleable(info({ kind: "external" }))).toBe(false);
  });
});

describe("installAction (Browse tab, B4)", () => {
  it("maps each install state onto exactly one action", () => {
    expect(installAction("installable")).toEqual({
      label: "Install…",
      actionable: true,
    });
    expect(installAction("update_available")).toEqual({
      label: "Update…",
      actionable: true,
    });
  });

  it("an installed, current extension is never a clickable install", () => {
    expect(installAction("installed").actionable).toBe(false);
  });
});

describe("formatBytes", () => {
  it("renders human sizes for the consent dialog", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(48213)).toBe("47.1 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
  });
});

// Source invariants — the contracts the dialog must not silently lose.
describe("ExtensionsPanel source invariants", () => {
  const src = readFileSync(
    join(process.cwd(), "src/components/ExtensionsPanel.tsx"),
    "utf8",
  );

  it("renders the sanctioned panel slot through the app markdown pipeline", () => {
    expect(src).toContain("<MarkdownView body={info.panel}");
    expect(src).not.toContain("dangerouslySetInnerHTML");
  });

  it("refreshes on the host's extensions-changed event", () => {
    expect(src).toContain('listen("extensions-changed"');
    expect(src).toContain('invoke<ExtensionInfo[]>("extensions_list")');
  });

  it("uninstall is a two-step confirm, never a single click", () => {
    expect(src).toContain("Really uninstall?");
    expect(src).toContain('invoke("extension_uninstall"');
  });

  it("installs are consent-bound: the dialog's sha256 travels with the call", () => {
    // The consent dialog must show the exact artifact hash…
    expect(src).toContain("{entry.artifact.sha256}");
    // …and the install must carry it so the backend can refuse a drifted
    // index entry (never a bare name-only install).
    expect(src).toMatch(
      /invoke\("marketplace_install",\s*\{\s*name:\s*consent\.name,\s*sha256:\s*consent\.artifact\.sha256,/,
    );
  });

  it("consent spells out scopes and events in plain language", () => {
    expect(src).toContain("This extension can");
    expect(src).toContain("scope_details.map");
    expect(src).toContain("event_details.map");
    expect(src).toContain("min_redline_ok");
  });

  it("updates re-consent through the same dialog — never automatic", () => {
    expect(src).toContain('"update_available"');
    // The only invoke of marketplace_install sits behind the consent dialog's
    // confirm; there is no second, automatic path.
    expect(src.split('invoke("marketplace_install"').length).toBe(2);
  });

  it("browse fetches through the cached-index command, with manual refresh", () => {
    expect(src).toContain('invoke<MarketplaceIndexView>("marketplace_index"');
    expect(src).toContain("load(true)");
  });

  it("sits in the Settings menu as its own row", () => {
    const settings = readFileSync(
      join(process.cwd(), "src/components/SettingsMenu.tsx"),
      "utf8",
    );
    expect(settings).toContain('<Row label="Extensions">{extensions}</Row>');
    const header = readFileSync(
      join(process.cwd(), "src/components/Header.tsx"),
      "utf8",
    );
    expect(header).toContain("extensions={<ExtensionsPanel />}");
  });
});
