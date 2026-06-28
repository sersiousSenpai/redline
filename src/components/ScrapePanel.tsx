// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The schema-driven scrape dialog. Rendered as HTML inside the browser pane's
//! slot — visible because opening it flips `useMenuOverlay`, which hides the
//! native webview underneath. The panel is pure presentation: it picks/edits a
//! schema (the malleable shell), runs it via the kernel, previews the structured
//! result, and saves it as JSON. Every author funnels through `validateSchema`
//! upstream, so this never executes anything.

import type { ScrapeResult, ScrapeSchema } from "../lib/scrapeSchema";

interface ScrapePanelProps {
  presets: ScrapeSchema[];
  customSchemas: ScrapeSchema[];
  /** The schema JSON the user is editing (source of truth for edits). */
  schemaText: string;
  /** Parse/validate error of `schemaText`, or null when it's valid. */
  schemaError: string | null;
  result: ScrapeResult | null;
  busy: boolean;
  /** Run/save error (distinct from the schema validation error). */
  error: string | null;
  /** Active file-explorer folder, when one is open — enables one-click save. */
  projectDir?: string | null;
  /** Remembered default output folder, when set. */
  defaultDir: string | null;
  onPickSchema: (schema: ScrapeSchema) => void;
  onChangeText: (text: string) => void;
  onRun: () => void;
  onSaveSchema: () => void;
  onSaveJson: (target: "default" | "pick" | "project") => void;
  onCancel: () => void;
}

const labelStyle: React.CSSProperties = {
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--color-ink-muted)",
};

const fieldStyle: React.CSSProperties = {
  fontSize: "13px",
  border: "1px solid var(--color-rule)",
  background: "var(--color-paper)",
  color: "var(--color-ink)",
  borderRadius: "4px",
  padding: "6px 8px",
  width: "100%",
};

const btnStyle: React.CSSProperties = {
  fontSize: "12px",
  border: "1px solid var(--color-rule)",
  background: "var(--color-bg-elevated)",
  color: "var(--color-ink)",
  borderRadius: "4px",
  padding: "4px 10px",
  cursor: "pointer",
};

export function ScrapePanel({
  presets,
  customSchemas,
  schemaText,
  schemaError,
  result,
  busy,
  error,
  projectDir,
  defaultDir,
  onPickSchema,
  onChangeText,
  onRun,
  onSaveSchema,
  onSaveJson,
  onCancel,
}: ScrapePanelProps) {
  const canSave = !!result?.ok && !busy;
  const groups: { label: string; schemas: ScrapeSchema[] }[] = [
    { label: "Presets", schemas: presets },
    ...(customSchemas.length ? [{ label: "Saved", schemas: customSchemas }] : []),
  ];

  // The <select> value encodes group + index so duplicate names don't collide.
  const onSelect = (value: string) => {
    const [g, i] = value.split(":").map(Number);
    const schema = groups[g]?.schemas[i];
    if (schema) onPickSchema(schema);
  };

  return (
    <div
      className="absolute inset-0 flex items-start justify-center overflow-auto"
      style={{ background: "color-mix(in srgb, var(--color-paper) 70%, transparent)" }}
    >
      <div
        className="rl-thin-scroll-y flex flex-col gap-3 m-6 p-5"
        style={{
          width: "min(680px, 94%)",
          maxHeight: "calc(100% - 48px)",
          overflowY: "auto",
          background: "var(--color-bg-elevated)",
          border: "1px solid var(--color-rule)",
          borderRadius: "8px",
          boxShadow: "0 8px 30px rgba(0,0,0,0.3)",
        }}
      >
        <div className="font-mono" style={{ fontSize: "13px", color: "var(--color-ink)" }}>
          Scrape page → JSON
        </div>

        <label className="flex flex-col gap-1">
          <span style={labelStyle}>Schema</span>
          <select
            onChange={(e) => onSelect(e.target.value)}
            defaultValue=""
            style={fieldStyle}
          >
            <option value="" disabled>
              Choose a schema…
            </option>
            {groups.map((group, g) => (
              <optgroup key={group.label} label={group.label}>
                {group.schemas.map((s, i) => (
                  <option key={`${g}:${i}`} value={`${g}:${i}`}>
                    {s.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span style={labelStyle}>Schema JSON (edit to adapt)</span>
          <textarea
            value={schemaText}
            onChange={(e) => onChangeText(e.target.value)}
            spellCheck={false}
            rows={10}
            className="font-mono"
            style={{
              ...fieldStyle,
              fontSize: "12px",
              lineHeight: 1.5,
              resize: "vertical",
              whiteSpace: "pre",
              overflowWrap: "normal",
            }}
          />
          {schemaError && (
            <span style={{ fontSize: "11px", color: "var(--color-danger, #c0392b)" }}>
              {schemaError}
            </span>
          )}
        </label>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRun}
            disabled={busy || !!schemaError}
            style={{
              ...btnStyle,
              background: "var(--color-anchor-bg)",
              color: "var(--color-anchor-text)",
              cursor: busy || schemaError ? "default" : "pointer",
              opacity: busy || schemaError ? 0.6 : 1,
            }}
          >
            {busy ? "Working…" : "Run scrape"}
          </button>
          <button
            type="button"
            onClick={onSaveSchema}
            disabled={!!schemaError}
            style={{ ...btnStyle, opacity: schemaError ? 0.6 : 1 }}
            title="Save this schema for reuse"
          >
            Save schema
          </button>
        </div>

        {result && (
          <div className="flex flex-col gap-1">
            <span style={labelStyle}>Result preview</span>
            <pre
              className="rl-thin-scroll-y font-mono"
              style={{
                fontSize: "12px",
                lineHeight: 1.45,
                margin: 0,
                padding: "8px",
                maxHeight: "240px",
                overflow: "auto",
                background: "var(--color-paper)",
                border: "1px solid var(--color-rule)",
                borderRadius: "4px",
                color: "var(--color-ink)",
                whiteSpace: "pre",
              }}
            >
              {JSON.stringify(result.data, null, 2)}
            </pre>
            {result.warnings.length > 0 && (
              <ul style={{ fontSize: "11px", color: "var(--color-ink-muted)", paddingLeft: "16px", margin: "2px 0 0" }}>
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {error && (
          <div style={{ fontSize: "12px", color: "var(--color-danger, #c0392b)" }}>
            {error}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          <button type="button" onClick={onCancel} disabled={busy} style={btnStyle}>
            Close
          </button>
          <div className="flex items-center gap-2">
            {projectDir && (
              <button
                type="button"
                onClick={() => onSaveJson("project")}
                disabled={!canSave}
                style={{ ...btnStyle, opacity: canSave ? 1 : 0.5 }}
                title={`Save into the open project folder (${projectDir})`}
              >
                Save to project
              </button>
            )}
            <button
              type="button"
              onClick={() => onSaveJson("pick")}
              disabled={!canSave}
              style={{ ...btnStyle, opacity: canSave ? 1 : 0.5 }}
              title="Choose a folder to save the JSON"
            >
              Choose folder…
            </button>
            <button
              type="button"
              onClick={() => onSaveJson("default")}
              disabled={!canSave}
              style={{
                ...btnStyle,
                background: "var(--color-anchor-bg)",
                color: "var(--color-anchor-text)",
                opacity: canSave ? 1 : 0.5,
              }}
              title={defaultDir ? `Save to ${defaultDir}` : "Pick a folder, then remember it"}
            >
              Save JSON
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
