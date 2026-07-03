// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { guessProjectForPlan } from "./guessProject";
import type { ProjectOption } from "../components/ProjectPicker";

const opt = (name: string, path: string): ProjectOption => ({
  name,
  path,
  source: "session",
});

describe("guessProjectForPlan", () => {
  const options = [
    opt("redline", "/Users/me/redline"),
    opt("qwallah", "/Users/me/qwallah"),
    opt("qwallah-crm", "/Users/me/qwallah-crm"),
  ];

  it("matches a repo named in the plan text", () => {
    const md = "# Plan\nRefactor the auth layer in the redline app.";
    expect(guessProjectForPlan(md, options)).toBe("/Users/me/redline");
  });

  it("prefers the longer name when both appear (qwallah-crm over qwallah)", () => {
    const md = "The stack already in `qwallah-crm` needs a new table.";
    expect(guessProjectForPlan(md, options)).toBe("/Users/me/qwallah-crm");
  });

  it("is case-insensitive", () => {
    const md = "Build the Redline feature.";
    expect(guessProjectForPlan(md, options)).toBe("/Users/me/redline");
  });

  it("does not match a name embedded inside another word", () => {
    const md = "This work is streamlined and underlined.";
    expect(guessProjectForPlan(md, options)).toBeNull();
  });

  it("returns null when no known repo is mentioned", () => {
    const md = "A generic plan about widgets and gizmos.";
    expect(guessProjectForPlan(md, options)).toBeNull();
  });

  it("ignores names shorter than 3 chars", () => {
    const md = "go go go";
    expect(guessProjectForPlan(md, [opt("go", "/Users/me/go")])).toBeNull();
  });
});
