// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { documentPlateMode } from "./documentPlate";

const SESSIONS = { kind: "sessions" } as const;
const FOLDER = { kind: "folder", id: "/repo" } as const;

describe("documentPlateMode", () => {
  it("nothing open → the door", () => {
    expect(documentPlateMode(SESSIONS, null, null)).toBe("door");
    expect(documentPlateMode(FOLDER, null, null)).toBe("door");
  });

  it("a selected session → the plan", () => {
    expect(documentPlateMode(SESSIONS, "s1", null)).toBe("plan");
  });

  it("a file open on a folder tab → the viewer, over any plan beneath", () => {
    expect(documentPlateMode(FOLDER, null, "/repo/a.ts")).toBe("file");
    expect(documentPlateMode(FOLDER, "s1", "/repo/a.ts")).toBe("file");
  });

  it("a file is only the viewer on a FOLDER tab", () => {
    // Back on the sessions tab the plan returns even though `activeFile` is
    // still set — the viewer is a property of the folder workspace.
    expect(documentPlateMode(SESSIONS, "s1", "/repo/a.ts")).toBe("plan");
    expect(documentPlateMode(SESSIONS, null, "/repo/a.ts")).toBe("door");
  });

  it("a loading plan is still the plan, so the door cannot flash", () => {
    // `activeId` is the SELECTED session, ready or not.
    expect(documentPlateMode(SESSIONS, "still-loading", null)).toBe("plan");
  });
});
