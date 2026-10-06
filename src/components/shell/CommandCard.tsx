// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";
/** Shared presentation for a hosted Bash tool and an ordinary shell command. */
export function CommandCard({
  command,
  output,
  running = false,
  children,
}: {
  command: string;
  output?: string;
  running?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="rl-shell-command">
      <div>
        <span aria-hidden>› </span>
        <code>{command}</code>
        {running && <small> · Running</small>}
      </div>
      {output && <pre>{output}</pre>}
      {children}
    </div>
  );
}
