// SPDX-License-Identifier: Apache-2.0
/** Incremental OSC 133/633/7 reader before xterm. It never alters bytes sent
 * to the PTY or terminal, and bounded tails survive arbitrary chunk splits. */
export interface ShellCommandBlock {
  id: number;
  command: string;
  cwd: string | null;
  output: string;
  exitCode: number | null;
  finished: boolean;
}
export interface ShellScanState {
  integrated: boolean;
  promptReady: boolean;
  alternateScreen: boolean;
  cwd: string | null;
  running: ShellCommandBlock | null;
  completed: ShellCommandBlock[];
}
const OUTPUT_CAP = 256 * 1024,
  HISTORY_CAP = 80,
  HISTORY_BYTES = 2 * 1024 * 1024;
export class OscScanner {
  state: ShellScanState = {
    integrated: false,
    promptReady: false,
    alternateScreen: false,
    cwd: null,
    running: null,
    completed: [],
  };
  private pending = "";
  private decoder = new TextDecoder();
  private nextId = 1;
  private command = "Command";
  reset() {
    this.state = {
      integrated: false,
      promptReady: false,
      alternateScreen: false,
      cwd: null,
      running: null,
      completed: [],
    };
    this.pending = "";
    this.decoder = new TextDecoder();
    this.nextId = 1;
    this.command = "Command";
  }
  push(bytes: Uint8Array): ShellScanState {
    this.pending += this.decoder.decode(bytes, { stream: true });
    while (this.pending) {
      const escape = this.pending.indexOf("\x1b");
      if (escape < 0) {
        this.output(this.pending);
        this.pending = "";
        break;
      }
      if (escape > 0) {
        this.output(this.pending.slice(0, escape));
        this.pending = this.pending.slice(escape);
      }
      if (this.pending.length === 1) break;
      if (this.pending.startsWith("\x1b]")) {
        const end = /\x07|\x1b\\/.exec(this.pending.slice(2));
        if (!end) {
          if (this.pending.length > 65536) {
            this.output(this.pending);
            this.pending = "";
          }
          break;
        }
        const endAt = 2 + end.index,
          raw = this.pending.slice(0, endAt + end[0].length),
          body = this.pending.slice(2, endAt);
        if (!this.osc(body)) this.output(raw);
        this.pending = this.pending.slice(raw.length);
      } else if (this.pending.startsWith("\x1b[")) {
        const end = /^[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/.exec(
          this.pending.slice(2),
        );
        if (!end) {
          if (this.pending.length > 256) {
            this.output(this.pending);
            this.pending = "";
          }
          break;
        }
        const raw = "\x1b[" + end[0];
        if (/^\x1b\[\?(47|1047|1049)h$/.test(raw))
          this.state = { ...this.state, alternateScreen: true };
        if (/^\x1b\[\?(47|1047|1049)l$/.test(raw))
          this.state = { ...this.state, alternateScreen: false };
        this.output(raw);
        this.pending = this.pending.slice(raw.length);
      } else {
        this.output(this.pending.slice(0, 2));
        this.pending = this.pending.slice(2);
      }
    }
    return this.state;
  }
  private output(text: string) {
    if (this.state.running)
      this.state = {
        ...this.state,
        running: {
          ...this.state.running,
          output: (this.state.running.output + text).slice(-OUTPUT_CAP),
        },
      };
  }
  private osc(body: string): boolean {
    if (body.startsWith("633;E;")) {
      try {
        const bytes = Uint8Array.from(atob(body.slice(6)), (char) =>
          char.charCodeAt(0),
        );
        this.command = new TextDecoder().decode(bytes).slice(0, 16000);
      } catch {
        this.command = "Command";
      }
      return true;
    }
    if (body.startsWith("7;")) {
      try {
        const url = new URL(body.slice(2));
        if (
          url.protocol === "file:" &&
          (!url.hostname || url.hostname === "localhost")
        )
          this.state = { ...this.state, cwd: decodeURIComponent(url.pathname) };
      } catch {
        /* malformed path is not actionable */
      }
      return true;
    }
    if (!body.startsWith("133;")) return false;
    const [, marker, value] = body.split(";");
    if (marker === "A")
      this.state = { ...this.state, integrated: true, promptReady: false };
    else if (marker === "B")
      this.state = { ...this.state, integrated: true, promptReady: true };
    else if (marker === "C") {
      this.state = {
        ...this.state,
        integrated: true,
        promptReady: false,
        running: {
          id: this.nextId++,
          command: this.command,
          cwd: this.state.cwd,
          output: "",
          exitCode: null,
          finished: false,
        },
      };
      this.command = "Command";
    } else if (marker === "D") {
      if (this.state.running) {
        const code = value && /^\d+$/.test(value) ? Number(value) : null;
        const completed = [
          ...this.state.completed,
          { ...this.state.running, finished: true, exitCode: code },
        ].slice(-HISTORY_CAP);
        let total = completed.reduce((n, block) => n + block.output.length, 0);
        while (total > HISTORY_BYTES && completed.length > 1)
          total -= completed.shift()!.output.length;
        this.state = { ...this.state, running: null, completed };
      }
    } else return false;
    return true;
  }
}
/** Only promote a literal Claude invocation, never a pipeline, redirect,
 * substitution, chained command, or shell alias whose meaning is unknown. */
export function promotableClaude(command: string): boolean {
  return (
    /^\s*claude(?:\s|$)/.test(command) &&
    !/[|;&<>`$*?\[\]{}~\n\r]/.test(command)
  );
}
