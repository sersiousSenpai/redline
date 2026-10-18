// Synthetic Tauri boundary only: every @tauri-apps/* import resolves here.
// The stage's components, the conversation, the plan editor and the theme are
// imported intact; the conversation's tail is the app-QA lane's scenario data
// for the board (fixtures/flow-app-qa), so the 4c column reads as the board.
import { dinTurnDone } from "../flow-app-qa/scenarios";

const noop = () => {};
const board = new URLSearchParams(location.search).get("board") ?? "4c";
export async function invoke(command: string, args?: Record<string, unknown>) {
  if (command === "convo_subscribe") {
    const terminalId = String(args?.terminalId ?? "");
    return { subscriptionId: `qa:${terminalId}`, events: board === "5a" ? [] : dinTurnDone(terminalId, "S-din"), hasOlder: false };
  }
  if (command === "convo_page") return { events: [], hasOlder: false };
  if (command === "pty_submit") return { status: "sent" };
  if (/prefs|settings|config/.test(command)) return null;
  return null;
}
export async function listen() { return noop; }
export async function once() { return noop; }
export async function emit() {}
export async function emitTo() {}
export function getCurrentWindow() { return { onCloseRequested: async () => noop, isFocused: async () => true, onFocusChanged: async () => noop, setTitle: async () => {} }; }
export function getCurrentWebview() { return { onDragDropEvent: async () => noop }; }
export async function open() { return null; }
export async function openUrl() {}
export async function homeDir() { return "/Users/imani"; }
export function convertFileSrc(path: string) { return path; }
export function isTauri() { return false; }
export class Channel { onmessage = noop; }
