import { describe, expect, it, vi } from "vitest";
import { emptyShellDraft, loadShellDraft, parseShellDraft, saveShellDraft } from "./drafts";
describe("shell draft recovery", () => {
  it("keeps drafts and queued prompts separate across remounts, without persisting context bodies", () => {
    const id=crypto.randomUUID();
    const chip={label:"Pricing plan",request:{kind:"plan" as const,sessionId:"plan-1",section:"2"},preview:[{kind:"plan",label:"Pricing",origin:"Plan",body:"private captured body"}]};
    const draft={...emptyShellDraft("plan"),text:"Unsent question",chips:[chip],queue:[{text:"Queued instruction",memory:true,chips:[chip]}],memory:true};
    expect(saveShellDraft(id,draft)).toEqual({retained:true,reloadSafe:true});
    const recovered=loadShellDraft(id);
    expect(recovered.text).toBe("Unsent question");expect(recovered.queue[0].text).toBe("Queued instruction");
    expect(recovered.chips[0].request).toEqual(chip.request);expect(recovered.memory).toBe(true);expect(recovered.mode).toBe("plan");
    expect(sessionStorage.getItem("redline.shell.draft.v1:"+id)).not.toContain("private captured body");
  });
  it("retains an in-window handoff copy when storage is unavailable", () => {
    const blocked=vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw new Error("quota");});
    const id=crypto.randomUUID(),draft={...emptyShellDraft(),text:"Keep this draft"};
    expect(saveShellDraft(id,draft)).toEqual({retained:true,reloadSafe:false});
    expect(loadShellDraft(id).text).toBe(draft.text);blocked.mockRestore();
  });
  it("rejects malformed storage and only restores bounded native context descriptors", () => {
    expect(parseShellDraft("{").text).toBe("");
    const draft=parseShellDraft(JSON.stringify({text:"hello",queue:Array.from({length:8},()=>({text:"queued"})),chips:[{label:"file",request:{kind:"file",path:"src/main.rs",body:"injected"},preview:[]}],mode:"bypassPermissions"}));
    expect(draft.queue).toHaveLength(5);expect(draft.mode).toBe("default");
    expect(draft.chips[0].request).toEqual({kind:"file",path:"src/main.rs"});
  });
});
