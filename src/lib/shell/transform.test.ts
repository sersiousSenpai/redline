// SPDX-License-Identifier: Apache-2.0
import {expect,it} from "vitest";
import {transformEvents,shellLinks} from "./transform";
import {hostedClaudeCommand} from "./promote";
import type {ShellEvent} from "./types";
const events=(rows:[string,Record<string,unknown>][]):ShellEvent[]=>rows.map(([kind,data],index)=>({seq:index+1,kind,data}));
it("preserves user prompt bytes including reminder-like text",()=>{const text="  <system-reminder>quoted user prose</system-reminder>\n";expect(transformEvents(events([["user",{text}]]))[0].text).toBe(text);});
it("folds contiguous exploration but preserves tool result identity",()=>{const blocks=transformEvents(events([["tool",{id:"a",name:"Read",input:{file_path:"a"}}],["tool-result",{id:"a",content:"one"}],["tool",{id:"b",name:"Grep",input:{pattern:"x"}}],["tool",{id:"c",name:"Bash",input:{command:"ls"}}]]));expect(blocks).toHaveLength(2);expect(blocks[0]).toMatchObject({output:"one",done:true,children:[{id:"b"}]});expect(blocks[1].kind).toBe("command");});
it("keeps permission replay idempotent and resolutions bound to request id",()=>{const blocks=transformEvents(events([["permission",{requestId:"p",name:"Write"}],["permission",{requestId:"p",name:"Write"}],["permission-resolved",{requestId:"p",decision:"deny"}]]));expect(blocks).toHaveLength(1);expect(blocks[0]).toMatchObject({resolved:true,text:"Denied"});});
it("keeps plan feedback and agent tool nesting readable",()=>{const blocks=transformEvents(events([["tool",{id:"a",name:"Workflow",input:{name:"review"}}],["tool",{id:"child",name:"Bash",parentId:"a",input:{command:"pwd"}}],["tool",{id:"plan",name:"ExitPlanMode"}],["tool-result",{id:"plan",content:"revise",error:true}]]));expect(blocks[0].children?.[0].id).toBe("child");expect(blocks[1].text).toContain("revising");});
it("does not duplicate delta text on completion",()=>{const blocks=transformEvents(events([["delta",{text:"Hello"}],["delta",{text:" there"}],["complete",{text:"Hello there"}]]));expect(blocks).toHaveLength(1);expect(blocks[0]).toMatchObject({text:"Hello there",done:true});});
it("promotes only supported literal Claude arguments",()=>{expect(hostedClaudeCommand('claude --model sonnet --effort high --permission-mode plan "Review this"',"/repo")).toMatchObject({model:"sonnet",effort:"high",permissionMode:"plan",prompt:"Review this"});for(const command of ['claude | tee log','claude --unknown value','claude "$SECRET"','claude --resume','claude --continue'])expect(hostedClaudeCommand(command,"/repo")).toBeNull();});
it("keeps relative links relative, supports quoted paths and line/column suffixes, and ignores commands", () => {
  expect(shellLinks("See src/App.tsx:12:4, `./src/my file.ts` and /Users/me/repo/file.rs. README.md:2 rl:blk-abc /raw /review javascript:alert(1)")).toEqual([
    {kind:"file",value:"src/App.tsx:12:4"},{kind:"file",value:"./src/my file.ts"},{kind:"file",value:"/Users/me/repo/file.rs"},{kind:"file",value:"README.md:2"},{kind:"block",value:"rl:blk-abc"},
  ]);
});
