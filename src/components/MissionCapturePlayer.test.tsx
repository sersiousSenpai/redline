import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), foundation: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../lib/missionFoundation", () => ({ missionFoundation: mocks.foundation }));
import { MissionCapturePlayer } from "./MissionCapturePlayer";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const record = (status = "indexed") => ({
  id: "capture-1", status, startedAt: 1700000000000, endedAt: 1700000002000,
  keyframes: [{ at: 1700000000000, mediaRef: "shot://frame-a" }, { at: 1700000002000, mediaRef: "shot://frame-b" }],
  derivatives: { ocr: "Securities investigation", summary: "Two captured frames with recognized page text." },
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.listen.mockResolvedValue(() => {});
  mocks.foundation.mockResolvedValue(record());
  mocks.invoke.mockResolvedValue("data:image/png;base64,YQ==");
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const button = (text: string) => [...host.querySelectorAll("button")].find(node => node.textContent === text)!;

it("reads only the selected frame through its saved mission and capture scope", async () => {
  await act(async () => root.render(<MissionCapturePlayer missionId="mission-a" captureId="capture-1"/>));
  expect(mocks.foundation).toHaveBeenCalledWith("mission-a", { op: "getCapture", captureId: "capture-1" });
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(mocks.invoke).toHaveBeenLastCalledWith("mission_capture_frame", { missionId: "mission-a", captureId: "capture-1", key: "frame-a" });
  await act(async () => button("Next frame").click());
  expect(mocks.invoke).toHaveBeenLastCalledWith("mission_capture_frame", { missionId: "mission-a", captureId: "capture-1", key: "frame-b" });
  expect(host.querySelector("output")?.textContent).toContain("2 / 2 · +2.0s");
  expect(host.textContent).toContain("Securities investigation");
});

it("does not display a late image from the previously selected mission", async () => {
  let finishOld!: (value: string) => void;
  mocks.invoke.mockImplementation((_name: string, args: { missionId: string }) => args.missionId === "mission-a"
    ? new Promise<string>(resolve => { finishOld = resolve; })
    : Promise.resolve("data:image/png;base64,Yg=="));
  await act(async () => root.render(<MissionCapturePlayer missionId="mission-a" captureId="capture-1"/>));
  await act(async () => root.render(<MissionCapturePlayer missionId="mission-b" captureId="capture-1"/>));
  expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,Yg==");
  await act(async () => finishOld("data:image/png;base64,YQ=="));
  expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,Yg==");
});

it("never requests an expired frame even if historical references remain in the record", async () => {
  mocks.foundation.mockResolvedValue(record("expired"));
  await act(async () => root.render(<MissionCapturePlayer missionId="mission-a" captureId="capture-1"/>));
  expect(host.textContent).toContain("This recording has expired");
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(host.querySelector("img")).toBeNull();
});

it("retries an unavailable frame without initiating a new capture", async () => {
  mocks.invoke.mockRejectedValueOnce(new Error("Frame was removed"));
  await act(async () => root.render(<MissionCapturePlayer missionId="mission-a" captureId="capture-1"/>));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Frame was removed");
  expect(host.textContent).not.toContain("Securities investigation");
  await act(async () => button("Retry frame").click());
  expect(host.querySelector("img")).not.toBeNull();
  expect(mocks.invoke.mock.calls.map(call => call[0])).toEqual(["mission_capture_frame", "mission_capture_frame"]);
});

it("clears previously displayed pixels and OCR when refreshed scope no longer permits the capture", async () => {
  await act(async () => root.render(<MissionCapturePlayer missionId="mission-a" captureId="capture-1"/>));
  expect(host.querySelector("img")).not.toBeNull();
  expect(host.textContent).toContain("Securities investigation");
  mocks.foundation.mockRejectedValueOnce(new Error("Capture source is now excluded"));
  await act(async () => button("Refresh recording").click());
  expect(host.querySelector("img")).toBeNull();
  expect(host.textContent).not.toContain("Securities investigation");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("now excluded");
});
