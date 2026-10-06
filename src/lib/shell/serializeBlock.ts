// SPDX-License-Identifier: Apache-2.0
import type { IBufferCell, ITheme, Terminal } from "@xterm/xterm";
export interface CommandSnapshot {
  html: string;
  ansi: string;
}
const escape = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
const palette = [
  "000000",
  "cc0000",
  "4e9a06",
  "c4a000",
  "3465a4",
  "75507b",
  "06989a",
  "d3d7cf",
  "555753",
  "ef2929",
  "8ae234",
  "fce94f",
  "729fcf",
  "ad7fa8",
  "34e2e2",
  "eeeeec",
];
function color(index: number): string {
  if (index < 16) return palette[index] ?? "000000";
  if (index >= 232)
    return Math.min(255, 8 + (index - 232) * 10)
      .toString(16)
      .padStart(2, "0")
      .repeat(3);
  const n = index - 16;
  const channel = (v: number) =>
    (v ? 55 + 40 * v : 0).toString(16).padStart(2, "0");
  return (
    channel(Math.floor(n / 36)) +
    channel(Math.floor(n / 6) % 6) +
    channel(n % 6)
  );
}
function style(cell: IBufferCell): string {
  const css: string[] = [];
  if (cell.isFgRGB())
    css.push(`color:#${cell.getFgColor().toString(16).padStart(6, "0")}`);
  else if (cell.isFgPalette()) css.push(`color:#${color(cell.getFgColor())}`);
  if (cell.isBgRGB())
    css.push(
      `background-color:#${cell.getBgColor().toString(16).padStart(6, "0")}`,
    );
  else if (cell.isBgPalette())
    css.push(`background-color:#${color(cell.getBgColor())}`);
  if (cell.isBold()) css.push("font-weight:bold");
  if (cell.isItalic()) css.push("font-style:italic");
  if (cell.isUnderline()) css.push("text-decoration:underline");
  return css.join(";");
}
/** addon-serialize 0.13's HTML output does not escape terminal text. Build
 * HTML from public buffer cells with explicit escaping and fixed CSS only. */
function safeHtml(terminal: Terminal): string {
  const lines: string[] = [];
  for (let y = 0; y < terminal.buffer.active.length; y++) {
    const line = terminal.buffer.active.getLine(y);
    if (!line) continue;
    let row = "",
      run = "",
      current = "";
    const flush = () => {
      if (run)
        row += current
          ? `<span style="${current}">${escape(run)}</span>`
          : escape(run);
      run = "";
    };
    const length = line.translateToString(true).length;
    let chars = 0;
    for (let x = 0; x < line.length && chars < length; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      const next = style(cell);
      if (next !== current) {
        flush();
        current = next;
      }
      const value = cell.getChars() || " ";
      chars += value.length;
      run += value;
    }
    flush();
    lines.push(row);
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return `<pre>${lines.join("\n")}</pre>`;
}
/** Only one short-lived parser exists at a time; no renderer, no WebGL. */
let queue: Promise<unknown> = Promise.resolve();
export function serializeBlock(
  output: string,
  cols: number,
  theme?: ITheme,
): Promise<CommandSnapshot> {
  const result = queue.then(async () => {
    const [{ Terminal }, { SerializeAddon }] = await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-serialize"),
    ]);
    const terminal = new Terminal({
      cols: Math.max(20, cols),
      rows: 1,
      scrollback: 5000,
      allowProposedApi: true,
      theme,
    });
    const addon = new SerializeAddon();
    terminal.loadAddon(addon);
    try {
      await new Promise<void>((resolve) => terminal.write(output, resolve));
      return {
        html: safeHtml(terminal),
        ansi: addon.serialize({ excludeAltBuffer: true, excludeModes: true }),
      };
    } finally {
      terminal.dispose();
    }
  });
  queue = result.catch(() => {});
  return result;
}
