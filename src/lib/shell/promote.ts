// SPDX-License-Identifier: Apache-2.0
import type { AgentShellLaunch } from "./types";
/** Parse only the literal CLI subset whose hosted meaning is identical.
 * Unknown flags, expansion, redirects and shell programs remain in the PTY. */
export function hostedClaudeCommand(command: string, cwd: string | null): AgentShellLaunch | null {
  if (/[|;&<>`\n\r$~]/.test(command)) return null;
  const tokens: string[] = []; let token = "", quote = "", active = false;
  for (const char of command.trim()) {
    if (char === "\\") return null;
    if (quote) { if (char === quote) quote = ""; else token += char; active = true; }
    else if (char === "'" || char === '"') {quote=char;active=true;}
    else if (/\s/.test(char)) {if(active){tokens.push(token);token="";active=false;}}
    else {token+=char;active=true;}
  }
  if (quote) return null; if(active)tokens.push(token);
  if(tokens.shift()!=="claude")return null;
  const request:AgentShellLaunch={cwd,prompt:"",permissionMode:"default",backend:"claude-code"}; const prompt:string[]=[];
  for(let index=0;index<tokens.length;index++) {
    const flag=tokens[index]; if(!flag.startsWith("-")){prompt.push(flag);continue;}
    const value=tokens[++index];if(value==null || value.startsWith("--"))return null;
    if(flag==="--resume"||flag==="-r")request.sessionId=value;
    else if(flag==="--model")request.model=value;
    else if(flag==="--effort")request.effort=value;
    else if(flag==="--add-dir")(request.addDirs??=[]).push(value);
    else if(flag==="--permission-mode" && ["plan","default","acceptEdits","auto"].includes(value))request.permissionMode=value as AgentShellLaunch["permissionMode"];
    else return null;
  }
  request.prompt=prompt.join(" ");return request;
}
