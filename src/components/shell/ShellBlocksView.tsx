// SPDX-License-Identifier: Apache-2.0
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";
import {
  TerminalView,
  type TerminalViewProps,
  tauriHandoffDeps,
} from "../TerminalView";
import {
  OscScanner,
  promotableClaude,
  type ShellScanState,
} from "../../lib/shell/oscScanner";
import { serializeBlock } from "../../lib/shell/serializeBlock";
import { CommandCard } from "./CommandCard";
import "./Shell.css";
import "./ShellBlocks.css";
export interface ShellBlocksViewProps extends TerminalViewProps {
  raw?: boolean;
  onPromoteClaude?: (
    id: string,
    command: string,
    cwd: string | null,
  ) => Promise<boolean>;
}
export const ShellBlocksView = memo(function ShellBlocksView({
  raw = false,
  onPromoteClaude,
  ...props
}: ShellBlocksViewProps) {
  const scanner = useRef(new OscScanner()),
    liveTerminal = useRef<Terminal | null>(null);
  const [scan, setScan] = useState<ShellScanState>(scanner.current.state),
    [html, setHtml] = useState<Record<number, string>>({}),
    [input, setInput] = useState(""),
    [history, setHistory] = useState<string[]>([]),
    [cursor, setCursor] = useState(-1),
    [error, setError] = useState<string | null>(null),
    [submitting, setSubmitting] = useState(false),
    [completions, setCompletions] = useState<string[]>([]);
  const pending = useRef(new Set<number>()),
    generation = useRef(0),
    frame = useRef<number | null>(null),
    inputRef = useRef<HTMLInputElement | null>(null),
    transcript = useRef<HTMLDivElement | null>(null);
  useEffect(
    () => () => {
      generation.current++;
      if (frame.current != null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  const onRawOutput = useCallback((bytes: Uint8Array, replay: boolean) => {
    if (replay) {
      generation.current++;
      scanner.current.reset();
      pending.current.clear();
      setHtml({});
    }
    scanner.current.push(bytes);
    // The PTY already batches over its channel; React gets at most one render
    // per frame, including hidden terminals and replay reconstruction.
    if (frame.current == null)
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        setScan(scanner.current.state);
      });
  }, []);
  const onTerminalReady = useCallback((terminal: Terminal | null) => {
    liveTerminal.current = terminal;
  }, []);
  useEffect(() => {
    const epoch = generation.current;
    const retained = new Set(scan.completed.map((block) => block.id));
    for (const id of pending.current) {
      if (!retained.has(id)) pending.current.delete(id);
    }
    setHtml((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([id]) => retained.has(Number(id))),
      ),
    );
    for (const block of scan.completed) {
      if (pending.current.has(block.id)) continue;
      pending.current.add(block.id);
      void serializeBlock(
        block.output,
        liveTerminal.current?.cols ?? 80,
        liveTerminal.current?.options.theme,
      )
        .then((snapshot) => {
          if (generation.current === epoch && scanner.current.state.completed.some((item) => item.id === block.id))
            setHtml((previous) => ({ ...previous, [block.id]: snapshot.html }));
        })
        .catch(() => {
          /* Plain text below remains readable if serialization fails. */
        });
    }
  }, [scan.completed]);
  useEffect(() => {
    if (!raw && scan.promptReady && props.visible) inputRef.current?.focus();
  }, [raw, scan.promptReady, props.visible]);
  useEffect(() => {
    transcript.current?.scrollTo?.({ top: transcript.current.scrollHeight });
  }, [scan.completed.length]);
  const live =
    raw ||
    !scan.integrated ||
    scan.alternateScreen ||
    !!scan.running ||
    !scan.promptReady;
  const run = async () => {
    if (!input.trim() || submitting || !scan.promptReady) return;
    const command = input;
    setError(null);
    setSubmitting(true);
    props.onUserInput?.(props.id);
    try {
      // A declined promotion stays an ordinary shell command, including all
      // complex shell syntax. Never reinterpret pipes/redirections as prompts.
      const promoted =
        !!onPromoteClaude &&
        promotableClaude(command) &&
        (await onPromoteClaude(props.id, command, scan.cwd ?? props.cwd));
      if (!promoted)
        await tauriHandoffDeps.writeChecked(props.id, `${command}\r`);
      setHistory((previous) =>
        [...previous.filter((item) => item !== command), command].slice(-100),
      );
      setCursor(-1);
      setInput("");
      setCompletions([]);
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };
  const complete = async () => {
    const word = /(?:^|\s)([^'"\s]*)$/.exec(input)?.[1];
    if (word == null) return;
    const captured = input;
    try {
      const paths = await invoke<string[]>("shell_complete_path", {
        id: props.id,
        word,
      });
      if (inputRef.current?.value !== captured) return;
      setCompletions(paths);
      if (paths.length === 1)
        setInput(captured.slice(0, captured.length - word.length) + paths[0]);
    } catch {
      setCompletions([]);
    }
  };
  return (
    <div
      className="rl-shell-blocks"
      style={{ display: props.visible ? "flex" : "none" }}
      onPointerDown={() => props.onPaneFocus?.(props.id)}
    >
      {!raw && !scan.alternateScreen && (
        <div
          className="rl-shell-blocks-history"
          ref={transcript}
          style={{ display: live ? "none" : "block" }}
        >
          {scan.completed.map((block) => (
            <CommandCard key={block.id} command={block.command}>
              {html[block.id] ? (
                <div
                  className="rl-shell-block-html"
                  dangerouslySetInnerHTML={{ __html: html[block.id] }}
                />
              ) : (
                <pre>
                  {block.output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")}
                </pre>
              )}
              <small>
                {block.exitCode === 0
                  ? "Finished"
                  : block.exitCode == null
                    ? "Finished"
                    : `Exited with code ${block.exitCode}`}{" "}
                {block.cwd && `· ${block.cwd}`}
              </small>
            </CommandCard>
          ))}
          {scan.completed.length === 0 && (
            <div className="rl-shell-blocks-empty">
              Ready in {scan.cwd ?? props.cwd ?? "your home folder"}. Type a
              command below.
            </div>
          )}
        </div>
      )}
      {!raw && scan.running && !scan.alternateScreen && (
        <div className="rl-shell-blocks-running">
          <code>{scan.running.command}</code>
          <span>Running</span>
          <button
            type="button"
            onClick={() => {
              void tauriHandoffDeps
                .writeChecked(props.id, "\x03")
                .catch((e) => setError(String(e)));
            }}
          >
            Stop
          </button>
        </div>
      )}
      {/* ONE TerminalView owns the PTY, channel, ACKs, replay and WebGL budget.
        Hiding its DOM at a prompt never detaches or recreates the driver. */}
      <div
        className="rl-shell-blocks-live"
        style={{ display: live ? "block" : "none" }}
      >
        <TerminalView
          {...props}
          visible={props.visible && live}
          onRawOutput={onRawOutput}
          onTerminalReady={onTerminalReady}
        />
      </div>
      {error && (
        <p role="alert" className="rl-shell-error">
          {error}
        </p>
      )}
      {!raw &&
        scan.integrated &&
        scan.promptReady &&
        !scan.running &&
        !scan.alternateScreen && (
          <form
            className="rl-shell-blocks-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void run();
            }}
          >
            <label
              htmlFor={`shell-command-${props.id}`}
              aria-label="Shell command"
            >
              ›
            </label>
            <input
              ref={inputRef}
              id={`shell-command-${props.id}`}
              autoComplete="off"
              spellCheck={false}
              value={input}
              disabled={submitting}
              placeholder="Type a command…"
              onChange={(event) => {
                setInput(event.target.value);
                setCursor(-1);
                setCompletions([]);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  const index =
                    cursor < 0 ? history.length - 1 : Math.max(0, cursor - 1);
                  setCursor(index);
                  setInput(history[index] ?? "");
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  const index = cursor < 0 ? history.length : cursor + 1;
                  setCursor(index);
                  setInput(history[index] ?? "");
                }
                if (event.key === "Tab") {
                  event.preventDefault();
                  void complete();
                }
              }}
            />
            <button type="submit" disabled={submitting || !input.trim()}>
              Run
            </button>
            {completions.length > 1 && (
              <div className="rl-shell-completions">
                {completions.map((path) => (
                  <button
                    key={path}
                    type="button"
                    onClick={() => {
                      setInput((value) => value.replace(/[^'"\s]*$/, path));
                      setCompletions([]);
                      inputRef.current?.focus();
                    }}
                  >
                    {path}
                  </button>
                ))}
              </div>
            )}
          </form>
        )}
    </div>
  );
});
export default ShellBlocksView;
