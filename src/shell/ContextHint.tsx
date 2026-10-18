// FLOW PLACEHOLDER — owned by start
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Stand-in for the start lane's one-line hint ("Select text to mark it." in
//! the plan footer), at its agreed props. The integrator keeps start's file.

import type { ReactNode } from "react";

export function ContextHint({ children, keys, className }: {
  children: ReactNode;
  keys?: string;
  className?: string;
}) {
  return (
    <p className={className ? `rl-context-hint ${className}` : "rl-context-hint"}>
      <span className="rl-context-hint-text">{children}</span>
      {keys && <kbd className="rl-context-hint-keys">{keys}</kbd>}
    </p>
  );
}

export default ContextHint;
