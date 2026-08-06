// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { CSSProperties, ReactNode } from "react";

// The control tier of the shell's three-tier language (hero dialog > plate >
// control): one button vocabulary for chrome verbs, derived tokens only.
// Absorbs the former per-file one-offs (Header's HeaderButton, the Footer
// actions, empty-state links) so every control reads against the plate it
// lives on instead of carrying its own ad-hoc style.
export type ButtonVariant = "default" | "accent" | "success" | "ghost";

interface ButtonProps {
  onClick: () => void;
  /** default: quiet verb on the elevated chrome surface. accent/success:
   *  filled emphasis (accent = the cluster's primary, success = the terminal
   *  "go" action). ghost: borderless quiet/link action. */
  variant?: ButtonVariant;
  /** Pressed/selected look (default variant only — mirrors aria-pressed). */
  active?: boolean;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  /** xs = header chrome, sm = footer/dialog actions. */
  size?: "xs" | "sm";
  /** Omitted ⇒ text-only button (the default for primary verbs). */
  icon?: ReactNode;
  /** Present ⇒ the readable text label beside/instead of a glyph. */
  label?: string;
  /** A glyph that reads as a symbol in mono/bold (e.g. `±`, `⇲`). */
  iconMono?: boolean;
  /** Arbitrary content (e.g. the Footer's verb + caption stack). Renders
   *  after icon/label when those are also given. */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function Button({
  onClick,
  variant = "default",
  active = false,
  disabled = false,
  title,
  ariaLabel,
  size = "xs",
  icon,
  label,
  iconMono = false,
  children,
  className,
  style,
}: ButtonProps) {
  const filled = variant === "accent" || variant === "success";
  const base: CSSProperties =
    variant === "ghost"
      ? {
          background: "transparent",
          border: "none",
          padding: 0,
          color: "var(--color-info)",
        }
      : {
          border: filled
            ? "1px solid transparent"
            : "1px solid var(--color-rule)",
          background:
            variant === "accent"
              ? "var(--color-info)"
              : variant === "success"
                ? "var(--color-success)"
                : active
                  ? "var(--color-anchor-bg)"
                  : "var(--color-bg-elevated)",
          color: filled
            ? "var(--color-on-accent)"
            : active
              ? "var(--color-anchor-text)"
              : "var(--color-ink)",
        };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={variant === "default" ? active : undefined}
      className={[
        "flex items-center gap-1.5 font-sans disabled:opacity-40",
        variant === "ghost" ? "" : size === "sm" ? "px-3 py-1" : "px-2 py-0.5",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        fontSize: size === "sm" ? "var(--rl-text-sm)" : "var(--rl-text-xs)",
        lineHeight: variant === "ghost" ? undefined : 1,
        borderRadius: variant === "ghost" ? undefined : "var(--rl-radius-control)",
        cursor: disabled ? "default" : "pointer",
        ...base,
        ...style,
      }}
    >
      {icon != null && (
        <span
          aria-hidden
          style={{
            fontSize: "var(--rl-text-md)",
            lineHeight: 1,
            ...(iconMono
              ? {
                  fontFamily: "var(--font-mono, ui-monospace, monospace)",
                  fontWeight: 700,
                }
              : null),
          }}
        >
          {icon}
        </span>
      )}
      {label && (
        <span style={{ fontWeight: variant === "ghost" ? 400 : 600 }}>
          {label}
        </span>
      )}
      {children}
    </button>
  );
}
