// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Which glyph a file gets in the Files rail and quick open (W4): a small,
// closed vocabulary decided from the name alone, so the tree never reads a
// file to draw its row. `FileTree` maps each kind to a 16px lucide icon.

export type FileIconKind =
  | "code"
  | "test"
  | "style"
  | "markup"
  | "data"
  | "markdown"
  | "image"
  | "package"
  | "lock"
  | "config"
  | "shell"
  | "text";

const CODE = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py", "go", "rb", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "lua", "zig", "dart", "scala", "ex", "exs", "vue", "svelte"]);
const STYLE = new Set(["css", "scss", "sass", "less", "pcss"]);
const MARKUP = new Set(["html", "htm", "xml", "svg"]);
const DATA = new Set(["json", "jsonc", "json5", "csv", "tsv", "sql", "graphql", "gql", "proto"]);
const MARKDOWN = new Set(["md", "markdown", "mdx", "rst", "txt"]);
const IMAGE = new Set(["png", "apng", "jpg", "jpeg", "jfif", "gif", "webp", "bmp", "ico", "avif", "icns", "tiff"]);
const CONFIG = new Set(["toml", "yaml", "yml", "ini", "conf", "cfg", "env", "plist", "editorconfig"]);
const SHELL = new Set(["sh", "bash", "zsh", "fish", "ps1"]);
const PACKAGE = new Set(["package.json", "cargo.toml", "pyproject.toml", "go.mod", "gemfile", "composer.json", "build.gradle", "pom.xml"]);
const LOCK = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "cargo.lock", "poetry.lock", "gemfile.lock", "go.sum", "bun.lockb"]);

/** The glyph kind for a file name (or path). */
export function fileIconKind(nameOrPath: string): FileIconKind {
  const name = nameOrPath.slice(nameOrPath.lastIndexOf("/") + 1).toLowerCase();
  if (LOCK.has(name)) return "lock";
  if (PACKAGE.has(name)) return "package";
  if (name === "dockerfile" || name === "makefile" || name.startsWith(".") && !name.slice(1).includes(".")) return "config";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  if (CODE.has(ext)) return /\.(test|spec)\.[a-z]+$/.test(name) || /_test\.(go|rs|py)$/.test(name) ? "test" : "code";
  if (STYLE.has(ext)) return "style";
  if (MARKUP.has(ext)) return "markup";
  if (DATA.has(ext)) return "data";
  if (MARKDOWN.has(ext)) return "markdown";
  if (IMAGE.has(ext)) return "image";
  if (CONFIG.has(ext)) return "config";
  if (SHELL.has(ext)) return "shell";
  return "text";
}
