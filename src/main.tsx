// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import {
  applyFont,
  applyLint,
  applyTheme,
  readStoredFont,
  readStoredLint,
  readStoredTheme,
} from "./theme/applyTheme";
import { isThemeName } from "./theme/themes";

// Apply the persisted theme + font + lint before first paint to avoid a flash
// of the default theme/typeface on launch. A stored *user* theme isn't
// registered this early — skip the apply and let index.html's replayed vars
// carry the paint; App re-applies once ~/.redline/themes is loaded.
const bootTheme = readStoredTheme();
if (isThemeName(bootTheme)) applyTheme(bootTheme);
applyFont(readStoredFont());
applyLint(readStoredLint());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
