// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The scrape *kernel* — the hard, unchanging nucleus. It has one fixed
//! contract: schema in → structured JSON out. The schema is injected into the
//! page as a single JSON literal that a fixed in-page interpreter walks at
//! runtime; selectors only ever reach the page as string arguments to
//! `querySelector`, so a schema can never become executable code. None of this
//! file changes when a schema changes — that is the whole point.

import { invoke } from "@tauri-apps/api/core";
import type { ScrapeResult, ScrapeSchema } from "./scrapeSchema";

// The fixed in-page interpreter, as a JS-source string. It is a pure data-walk:
// every field is read inside its own try/catch so one bad selector degrades to
// `null` + a warning rather than aborting the whole scrape. `clamp` honours a
// field's `maxChars`. It returns a plain object; the wrapper in
// `buildScrapeProgram` is what JSON-stringifies it (WKWebView hands the result
// back as an NSString, so every path must ultimately return a string).
const INTERPRETER = `function(schema){
  var warnings = [];
  function clamp(s, max){
    if (typeof s !== "string" || !max || s.length <= max) return s;
    warnings.push("truncated to " + max + " chars");
    return s.slice(0, max);
  }
  function read(ctx, f){
    try {
      if (f.type === "list"){
        var sel = f.itemSelector || f.selector;
        var items = sel ? Array.prototype.slice.call(ctx.querySelectorAll(sel)) : [];
        return items.map(function(el){
          if (f.itemFields && f.itemFields.length){
            var o = {};
            f.itemFields.forEach(function(s){ o[s.name] = read(el, s); });
            return o;
          }
          return clamp(el.innerText || "", f.maxChars);
        });
      }
      var el = f.selector ? ctx.querySelector(f.selector) : ctx;
      if (!el){ warnings.push("no match: " + f.name + " [" + f.selector + "]"); return null; }
      switch (f.type){
        case "text": return clamp(el.innerText || "", f.maxChars);
        case "html": return clamp(el.innerHTML || "", f.maxChars);
        case "attr": return el.getAttribute(f.attribute || "");
        default: warnings.push("unknown type: " + f.type + " (" + f.name + ")"); return null;
      }
    } catch(e){ warnings.push(f.name + ": " + String(e)); return null; }
  }
  var base = schema.root ? (document.querySelector(schema.root) || document) : document;
  var data = {};
  (schema.fields || []).forEach(function(f){ data[f.name] = read(base, f); });
  return { ok:true, version: schema.version, schemaName: schema.name || "",
           url: location.href, title: document.title || "",
           data: data, warnings: warnings };
}`;

/** Build the self-contained JS program evaluated in the page. The schema is
 *  embedded via `JSON.stringify` (which emits valid JS-literal syntax and does
 *  all the escaping) and the whole thing is wrapped so it returns a JSON string
 *  on *every* path — success or failure. Built by concatenation, never
 *  `String.replace`, because a `$&`/`$1` inside a selector would corrupt a
 *  replacement string. */
export function buildScrapeProgram(schema: ScrapeSchema): string {
  return `(function(){try{return JSON.stringify((${INTERPRETER})(${JSON.stringify(
    schema,
  )}));}catch(e){return JSON.stringify({ok:false,error:String(e)});}})()`;
}

/** Parse the raw string the bridge returns into a `ScrapeResult`, tolerating
 *  garbage (the page returning "" on failure, or any non-JSON) by degrading to
 *  `{ ok:false, error }` rather than throwing. */
export function parseScrapeResult(raw: string, schema: ScrapeSchema): ScrapeResult {
  const fallback: ScrapeResult = {
    ok: false,
    version: schema.version,
    schemaName: schema.name,
    url: "",
    title: "",
    data: {},
    warnings: [],
  };
  try {
    const v = JSON.parse(raw) as Partial<ScrapeResult>;
    if (typeof v.ok !== "boolean") {
      return { ...fallback, error: "malformed scrape result" };
    }
    return {
      ...fallback,
      ...v,
      data: v.data ?? {},
      warnings: v.warnings ?? [],
    };
  } catch (e) {
    return { ...fallback, error: `unparseable scrape result: ${String(e)}` };
  }
}

/** Execute a schema against a browser tab and return the structured result.
 *  `label` is the native webview label (`browser-<id>`). This is the only call
 *  the UI makes — every author funnels into it after `validateSchema`. */
export async function runScrapeSchema(
  label: string,
  schema: ScrapeSchema,
): Promise<ScrapeResult> {
  const raw = await invoke<string>("browser_eval_result", {
    label,
    script: buildScrapeProgram(schema),
  });
  return parseScrapeResult(raw, schema);
}
