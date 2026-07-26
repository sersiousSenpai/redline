// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  /** Renders in place of the crashed subtree. `reset` clears the error and
   *  retries the children. */
  fallback: (err: Error, reset: () => void) => ReactNode;
  children?: ReactNode;
}

// Scoped crash containment. Without any boundary, a render throw anywhere
// unmounts the ENTIRE tree — and every mounted TerminalView's unmount cleanup
// kills its PTY, so one bad render used to silently end every shell session.
// Boundaries wrap independent regions so a crash stays inside its region and
// the terminal dock (always a sibling of a wrapped region, never a child)
// lives on.
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      "[redline] render error contained by boundary:",
      error,
      info.componentStack,
    );
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return this.props.fallback(this.state.error, this.reset);
    }
    return this.props.children;
  }
}

/** A standard inline fallback: quiet, theme-aware, with a retry. */
export function BoundaryFallback({
  region,
  error,
  reset,
}: {
  region: string;
  error: Error;
  reset: () => void;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 p-6 text-center"
      style={{ color: "var(--color-ink-muted)", fontSize: "13px" }}
    >
      <div style={{ color: "var(--color-ink)" }}>
        The {region} hit a rendering error.
      </div>
      <div
        className="font-mono"
        style={{ fontSize: "11px", maxWidth: "480px", wordBreak: "break-word" }}
      >
        {String(error?.message ?? error)}
      </div>
      <button
        type="button"
        onClick={reset}
        className="px-3 py-1 rounded"
        style={{
          border: "1px solid var(--color-rule)",
          background: "var(--color-bg-elevated)",
          color: "var(--color-ink)",
          cursor: "pointer",
        }}
      >
        Try again
      </button>
    </div>
  );
}
