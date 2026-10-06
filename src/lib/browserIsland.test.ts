import { expect, it } from "vitest";
import { browserIslandPrompt } from "./browserIsland";
it("attaches only opted-in page/task context and quotes bounded selections", () => {
  expect(browserIslandPrompt(" Build this ",null)).toBe("Build this");
  const prompt=browserIslandPrompt("Build this",{label:"browser-a",title:"A",url:"https://a.test",selection:"One\nTwo"},"# Task list\n- [ ] Fix nav");
  expect(prompt).toContain("URL: https://a.test"); expect(prompt).toContain("> One\n> Two"); expect(prompt).toContain("Attached task list:");
});
