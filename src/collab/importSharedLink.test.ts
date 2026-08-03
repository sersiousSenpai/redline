// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { encodeSnapshot, snapshotLink, type SnapshotPayload } from "./snapshot";
import { importSharedPlanFromUrl } from "./importSharedLink";

function payload(overrides: Partial<SnapshotPayload> = {}): SnapshotPayload {
  return {
    v: 1,
    requestId: "req-1",
    baseVersion: 3,
    reviewerName: "Jordan",
    projectName: "acme",
    planTitle: "Ship it",
    markdown: "<!-- rl:blk-abc -->\n# Ship it\n\nBody.",
    signingKey: "c2ln",
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("importSharedPlanFromUrl", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("decodes a redline:// deep link and imports the plan markdown", async () => {
    invoke.mockResolvedValue("shared-xyz");
    const token = await encodeSnapshot(payload());
    const url = snapshotLink("redline://open", token);

    const id = await importSharedPlanFromUrl(url);

    expect(id).toBe("shared-xyz");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("import_shared_plan", {
      markdown: "<!-- rl:blk-abc -->\n# Ship it\n\nBody.",
      projectName: "acme",
    });
  });

  it("passes null projectName when the snapshot omits one", async () => {
    invoke.mockResolvedValue("shared-1");
    const token = await encodeSnapshot(payload({ projectName: undefined }));
    await importSharedPlanFromUrl(`redline://open#${token}`);
    expect(invoke).toHaveBeenCalledWith("import_shared_plan", {
      markdown: expect.any(String),
      projectName: null,
    });
  });

  it("is a quiet no-op for a URL with no snapshot token", async () => {
    expect(await importSharedPlanFromUrl("redline://open#not-a-token")).toBeNull();
    expect(await importSharedPlanFromUrl("https://example.com")).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});
