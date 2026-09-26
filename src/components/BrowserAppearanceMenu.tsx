// SPDX-License-Identifier: Apache-2.0
import { BrowserDialog } from "./BrowserSurfaces";
import { DEFAULT_APPEARANCE, type BrowserAppearance } from "../lib/browserAppearance";
export function BrowserAppearanceMenu({ value, site, onChange, onClose }: { value: BrowserAppearance; site: string; onChange: (value: BrowserAppearance) => void; onClose: () => void }) {
  return <BrowserDialog title="Page appearance" subtitle={`Saved for ${site}. Redline’s own theme stays in Settings.`} onClose={onClose}
    footer={<button type="button" className="rb-button" onClick={() => onChange(DEFAULT_APPEARANCE)}>Reset this site</button>}>
    <div className="rb-setting" style={{ paddingTop: 0 }}><span>Website theme</span><div className="flex gap-1" role="group" aria-label="Website theme">{(["default", "light", "dark"] as const).map((theme) => <button key={theme} type="button" className="rb-button" aria-pressed={value.website === theme} style={value.website === theme ? { borderColor: "var(--color-info)", color: "var(--color-info)" } : undefined} onClick={() => onChange({ ...value, website: theme })}>{theme === "default" ? "Site default" : theme === "light" ? "Light" : "Dark"}</button>)}</div></div>
    <div className="rb-setting"><span>Page zoom</span><div className="flex items-center gap-2"><button className="rb-button" type="button" aria-label="Zoom out" onClick={() => onChange({ ...value, zoom: Math.max(.5, value.zoom - .1) })}>−</button><button className="rb-button" type="button" title="Reset page zoom" onClick={() => onChange({ ...value, zoom: 1 })}>{Math.round(value.zoom * 100)}%</button><button className="rb-button" type="button" aria-label="Zoom in" onClick={() => onChange({ ...value, zoom: Math.min(3, value.zoom + .1) })}>+</button></div></div>
    <details className="mt-4"><summary style={{ cursor: "pointer", color: "var(--color-ink-muted)" }}>Reading adjustments</summary>
      <label className="rb-setting"><span>Force dark colors<small>For websites without a dark theme. Images and media keep their original colors.</small></span><input type="checkbox" checked={value.website === "forced"} onChange={(e) => onChange({ ...value, website: e.target.checked ? "forced" : "default" })}/></label>
      <label className="rb-setting"><span>Reading filter</span><select value={value.reading} onChange={(e) => onChange({ ...value, reading: e.target.value as BrowserAppearance["reading"] })}><option value="none">None</option><option value="sepia">Sepia</option><option value="gray">Grayscale</option></select></label>
      {(["brightness", "contrast"] as const).map((key) => <label key={key} className="rb-setting"><span>{key === "brightness" ? "Brightness" : "Contrast"}</span><input aria-label={key} type="range" min="0.5" max={key === "contrast" ? 2 : 1.5} step="0.05" value={value[key]} onChange={(e) => onChange({ ...value, [key]: Number(e.target.value) })}/><output>{Math.round(value[key] * 100)}%</output></label>)}
    </details>
  </BrowserDialog>;
}
