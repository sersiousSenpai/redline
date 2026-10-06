import { describe, expect, it, vi } from "vitest";
import { continuationOrigin, handoffGate, continuationBriefError, hasContinuationMessages, prepareCompanionContinuation, prepareConversationPreview } from "./conversationContinuation";
describe("conversation brief provenance", () => {
  it("honors the selected message boundary and keeps suggestions separate from user direction", () => {
    const result = prepareConversationPreview({ conversationKind: "browse", conversationId: "stable", messages: [
      { id: "1", role: "user", body: "Keep the existing database", status: "complete" },
      { id: "2", role: "assistant", body: "We could replace it", status: "complete" },
      { id: "3", role: "user", body: "Do not", status: "complete" },
    ] }, "2");
    expect(result.source.messageIds).toEqual(["1", "2"]);
    expect(result.markdown).toContain("Assistant suggestion or response · 2");
    expect(result.markdown).not.toContain("Do not");
  });
  it("excludes unfinished and error messages", () => {
    const result = prepareConversationPreview({ conversationKind: "companion", conversationId: "chat", messages: [{ id: "1", role: "assistant", body: "partial", status: "error" }] });
    expect(result.source.messageIds).toEqual([]);
    expect(result.markdown).not.toContain("partial");
  });
  it("bounds multibyte previews by the backend's byte limit while preserving the source ID", () => {
    const result = prepareConversationPreview({ conversationKind: "browse", conversationId: "chat", messages: [{ id: "large", role: "user", body: "🧠".repeat(100_000), status: "complete" }] });
    expect(continuationBriefError(result.markdown)).toBeNull();
    expect(result.source.messageIds).toEqual(["large"]);
    expect(result.markdown).toContain("the full source message is linked");
    expect(result.markdown).not.toContain("\uFFFD");
    expect(continuationBriefError("🧠".repeat(65_000))).toContain("256 KB");
  });
  it("does not enable a continuation beyond an absent boundary or for system-only messages", () => {
    const source = { conversationKind: "browse" as const, conversationId: "chat", messages: [{ id: "a", role: "assistant", body: "Completed suggestion", status: "complete" }] };
    expect(hasContinuationMessages(source, "missing")).toBe(false);
    expect(hasContinuationMessages(source, "a")).toBe(true);
    expect(hasContinuationMessages({ ...source, messages: [{ ...source.messages[0], role: "system" }] })).toBe(false);
  });
});

describe("chat planning", () => {
  const source = { conversationKind: "companion" as const, conversationId: "chat", messages: [{ id: "first", role: "user", body: "Original direction", status: "complete" }] };
  it("persists an empty chat's exact instruction and links the durable row", async () => {
    const text = "  Build the editor\nKeep the existing database.\n";
    const seed = vi.fn(async (body: string) => ({ id: "durable-seed", role: "user", status: "complete", body }));
    const first = await prepareCompanionContinuation("chat", [], text, seed);
    const retry = await prepareCompanionContinuation("chat", [], text, seed);
    expect(seed).toHaveBeenCalledWith(text);
    expect(first.source.messageIds).toEqual(["durable-seed"]);
    expect(retry.source.messageIds).toEqual(first.source.messageIds);
    expect(first.markdown).toContain(text);
  });
  it("uses existing complete history without inserting another user turn", async () => {
    const seed = vi.fn();
    const preview = await prepareCompanionContinuation("chat", source.messages, "Plan it", seed);
    expect(seed).not.toHaveBeenCalled();
    expect(preview.source.messageIds).toEqual(["first"]);
  });
  it("does not prepare a launch when seed persistence fails or direction is empty", async () => {
    const seed = vi.fn().mockRejectedValue(new Error("disk unavailable"));
    await expect(prepareCompanionContinuation("chat", [], "Build it", seed)).rejects.toThrow("disk unavailable");
    seed.mockClear();
    await expect(prepareCompanionContinuation("chat", [], "  ", seed)).rejects.toThrow("Write an instruction");
    expect(seed).not.toHaveBeenCalled();
  });
  it("uses a final instruction as the Objective while preserving original context", () => {
    const preview = prepareConversationPreview(source, undefined, { instruction: "Local only" });
    expect(preview.markdown).toContain("## Objective\nLocal only");
    expect(preview.markdown).toContain("## Final instruction\nLocal only");
    expect(preview.markdown).toContain("Original direction");
    expect(prepareConversationPreview(source).markdown).toContain("## Objective\nOriginal direction");
  });
  it("records each continuation's true origin", () => {
    expect(continuationOrigin("companion")).toBe("chat");
    expect(continuationOrigin("drafter")).toBe("drafter");
    expect(continuationOrigin("browse")).toBe("browser");
  });
  it("waits until both the active turn and type-ahead queue finish", () => {
    expect(handoffGate("streaming", 0)).toBe(false);
    expect(handoffGate("idle", 1)).toBe(false);
    expect(handoffGate("error", 0)).toBe(false);
    expect(handoffGate("idle", 0)).toBe(true);
  });
});
