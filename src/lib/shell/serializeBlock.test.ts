import { expect, it, vi } from "vitest";
import { serializeBlock } from "./serializeBlock";
it("finished command output becomes escaped HTML without a live renderer", async () => {
  const canvas = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(null);
  const { html, ansi } = await serializeBlock(
    '<script>alert("x")</script>\r\n\x1b[31merror\x1b[0m',
    80,
  );
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("error");
  expect(ansi).toContain("error");
  canvas.mockRestore();
});
