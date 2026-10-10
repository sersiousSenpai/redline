// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import {
  describeVoice,
  gradeRank,
  isLowGrade,
  joinBlend,
  KOKORO_VOICES,
  splitBlend,
} from "./kokoroVoices";

describe("KOKORO_VOICES", () => {
  it("lists every English voice once, best grade first", () => {
    expect(KOKORO_VOICES).toHaveLength(28);
    expect(new Set(KOKORO_VOICES.map((v) => v.id)).size).toBe(28);
    expect(KOKORO_VOICES.slice(0, 2).map((v) => v.id)).toEqual(["af_heart", "af_bella"]);
    const ranks = KOKORO_VOICES.map((v) => gradeRank(v.grade));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("keeps the published order within a grade, so US comes before UK", () => {
    const bMinus = KOKORO_VOICES.filter((v) => v.grade === "B-").map((v) => v.id);
    expect(bMinus).toEqual(["af_nicole", "bf_emma"]);
  });

  it("the best male voices are the C+ ones, and am_adam is near the bottom", () => {
    const men = KOKORO_VOICES.filter((v) => v.kind === "US male" || v.kind === "UK male");
    expect(men.slice(0, 3).map((v) => `${v.id} ${v.grade}`)).toEqual([
      "am_fenrir C+",
      "am_michael C+",
      "am_puck C+",
    ]);
    expect(describeVoice("am_adam").grade).toBe("F+");
    expect(isLowGrade("F+")).toBe(true);
    expect(isLowGrade("C-")).toBe(false);
  });
});

describe("describeVoice", () => {
  it("reads the accent and voice from the id", () => {
    expect(describeVoice("af_heart")).toEqual({
      id: "af_heart",
      name: "Heart",
      kind: "US female",
      grade: "A",
    });
    expect(describeVoice("bm_george")).toMatchObject({ name: "George", kind: "UK male", grade: "C" });
  });

  it("names a voice it doesn't know without inventing a grade", () => {
    expect(describeVoice("jf_alpha")).toEqual({ id: "jf_alpha", name: "Alpha", kind: "", grade: "" });
    expect(gradeRank("")).toBeGreaterThan(gradeRank("F-"));
  });
});

describe("blends", () => {
  it("round-trip through the stored value", () => {
    expect(splitBlend("am_michael+am_fenrir")).toEqual(["am_michael", "am_fenrir"]);
    expect(splitBlend("af_heart")).toEqual(["af_heart", null]);
    expect(joinBlend("am_michael", "am_fenrir")).toBe("am_michael+am_fenrir");
    expect(joinBlend("am_michael", null)).toBe("am_michael");
    expect(joinBlend("am_michael", "am_michael")).toBe("am_michael");
  });
});
