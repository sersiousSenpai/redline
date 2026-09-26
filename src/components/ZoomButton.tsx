import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export const ZoomButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: ReactNode; active?: boolean }>(function ZoomButton({ label, title, active, style, ...props }, ref) {
  return <button type="button" {...props} ref={ref} title={title} aria-label={title} aria-pressed={active} style={{
    width: "22px", height: "22px", borderRadius: "50%", border: `1px solid ${active ? "var(--color-info)" : "var(--color-rule)"}`,
    background: "var(--color-paper)", color: active ? "var(--color-info)" : "var(--color-ink)", fontSize: "13px", lineHeight: 1,
    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, ...style,
  }}>{label}</button>;
});
