// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { releaseHiddenCaret, visiblePaneRoot } from "./caret";

afterEach(() => {
  document.body.innerHTML = "";
});

/** The stage's shape: a shown tab body with its focused pane, a hidden kept
 *  tab, and the terminal layer beside them holding xterm's helper textarea. */
function fixture() {
  document.body.innerHTML = `
    <div class="rl-wb-tab-body" data-hidden=""><div class="rl-wb-pane" data-focused="" tabindex="-1" id="hidden-pane"></div></div>
    <div class="rl-wb-tab-body"><div class="rl-wb-pane" tabindex="-1" id="other"></div><div class="rl-wb-pane" data-focused="" tabindex="-1" id="shown"></div></div>
    <div class="rl-wb-terminal-layer" id="layer"><div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div></div>`;
  const layer = document.getElementById("layer")!;
  const textarea = layer.querySelector("textarea")!;
  return { layer, textarea };
}

describe("a terminal's caret on leaving (the stray input-source glyph)", () => {
  it("hands the focus to the shown tab's focused pane: no textarea keeps it", () => {
    const { layer, textarea } = fixture();
    textarea.focus();
    expect(document.activeElement).toBe(textarea);
    layer.style.display = "none";
    expect(releaseHiddenCaret(layer)).toBe(true);
    expect(document.activeElement?.id).toBe("shown");
    expect(document.activeElement?.tagName).not.toBe("TEXTAREA");
    expect(document.querySelector("textarea:focus")).toBeNull();
  });

  it("never picks a pane of a hidden kept tab", () => {
    fixture();
    expect(visiblePaneRoot()?.id).toBe("shown");
  });

  it("leaves a caret outside the layer alone (a field the user is in)", () => {
    const { layer } = fixture();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    expect(releaseHiddenCaret(layer)).toBe(false);
    expect(document.activeElement).toBe(input);
  });
});
