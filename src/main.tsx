// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import {
  applyFont,
  applyTheme,
  readStoredFont,
  readStoredTheme,
} from "./theme/applyTheme";

// Apply the persisted theme + font before first paint to avoid a flash of the
// default theme/typeface on launch.
applyTheme(readStoredTheme());
applyFont(readStoredFont());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
