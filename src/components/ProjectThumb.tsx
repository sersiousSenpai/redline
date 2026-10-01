// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useState, type CSSProperties } from "react";
import "./ProjectThumb.css";

/** Repo identity for Localhost cards, using the same logo source as terminals.
 *  The name is the artwork when a logo is missing or cannot be decoded. */
export function ProjectThumb({ projectName, logo }: {
  projectName: string;
  logo: string | null;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const name = projectName.trim() || "Untitled project";
  const hasLogo = Boolean(logo && logo !== failedSrc);
  // Container units keep both small cards and long repository names in scale.
  const nameScale = Math.max(4.8, Math.min(13, 42 / Math.sqrt(Math.max(10, name.length))));

  return <div className="rl-project-art" data-has-logo={hasLogo} title={name}
    style={{ "--project-name-size": `${nameScale}cqw` } as CSSProperties}>
    <svg className="rl-project-art-lines" viewBox="0 0 400 250" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <path d="M-50 210 165-5M-20 245 215 10M105 295 400 0M225 300 440 85" />
      <path className="rl-project-art-strike" d="m290 178 61 61" />
      <circle cx="320" cy="208" r="65" />
      <circle cx="320" cy="208" r="88" />
    </svg>
    <div className="rl-project-art-identity">
      {hasLogo && <div className="rl-project-art-logo">
        <img src={logo!} alt={`${name} logo`} draggable={false}
          onError={() => setFailedSrc(logo)} />
      </div>}
      <span className="rl-project-art-name">{name}</span>
    </div>
    <span className="rl-project-art-rule" aria-hidden="true" />
  </div>;
}
