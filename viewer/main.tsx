// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import React from "react";
import ReactDOM from "react-dom/client";

import { Viewer } from "./Viewer";
import { applyTheme, applyFont, readStoredTheme, readStoredFont } from "../src/theme/applyTheme";
import "./viewer.css";

// Apply the reader's saved theme + font BEFORE the first React paint, writing
// the app's `--color-*` tokens inline on <html> — so the viewer opens in the
// recipient's chosen look (or Studio by default) with no flash. The whole
// stylesheet reads these vars, exactly like the desktop app.
applyTheme(readStoredTheme());
applyFont(readStoredFont());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Viewer />
  </React.StrictMode>,
);
