interface ResolutionWarningBannerProps {
  warning: {
    parseError: string | null;
    unmatchedIds: string[];
    unresolvedSubmittedIds: string[];
  };
  onDismiss: () => void;
}

export function ResolutionWarningBanner({
  warning,
  onDismiss,
}: ResolutionWarningBannerProps) {
  return (
    <div
      className="rounded-md border p-3"
      style={{
        borderColor: "var(--color-warning)",
        background: "color-mix(in srgb, var(--color-warning) 8%, transparent)",
        fontSize: "12px",
        color: "var(--color-ink)",
      }}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <span
          style={{
            fontSize: "10px",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--color-warning)",
          }}
        >
          Resolution block issue
        </span>
        <button
          type="button"
          onClick={onDismiss}
          className="opacity-60 hover:opacity-100"
          style={{ color: "var(--color-ink-muted)", fontSize: "12px" }}
        >
          ✕
        </button>
      </div>
      {warning.parseError && (
        <p style={{ lineHeight: 1.45, marginBottom: 6 }}>
          Claude's resolution block could not be parsed: {warning.parseError}
        </p>
      )}
      {warning.unmatchedIds.length > 0 && (
        <p style={{ lineHeight: 1.45, marginBottom: 6 }}>
          Resolutions for unknown comments: {warning.unmatchedIds.join(", ")}
        </p>
      )}
      {warning.unresolvedSubmittedIds.length > 0 && (
        <p style={{ lineHeight: 1.45 }}>
          Submitted comments without a resolution:{" "}
          {warning.unresolvedSubmittedIds.join(", ")}
        </p>
      )}
    </div>
  );
}
