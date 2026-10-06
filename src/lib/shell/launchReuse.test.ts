import { expect, it } from "vitest";
import { requiresHostedRestart } from "./launchReuse";
import type { AgentShellLaunch } from "./types";
const initial:AgentShellLaunch={cwd:"/old",prompt:"",permissionMode:"plan",addDirs:[],effort:"high"};
it("restarts moved-project sessions so new directory access is granted",()=>{expect(requiresHostedRestart("/old",initial,{...initial,addDirs:["/new"]})).toBe(true);expect(requiresHostedRestart("/old",initial,{...initial,cwd:"/new"})).toBe(true);});
it("restarts for revoked directories, settings and effort but reuses live mode/model controls",()=>{expect(requiresHostedRestart("/old",{...initial,addDirs:["/new"]},initial)).toBe(true);expect(requiresHostedRestart("/old",initial,{...initial,settingsPath:"/settings"})).toBe(true);expect(requiresHostedRestart("/old",initial,{...initial,effort:null})).toBe(true);expect(requiresHostedRestart("/old",initial,{...initial,permissionMode:"auto",model:"opus"})).toBe(false);});
