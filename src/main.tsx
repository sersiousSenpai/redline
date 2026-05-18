import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { applyTheme, readStoredTheme } from "./theme/applyTheme";

// Apply the persisted theme before first paint to avoid a flash of the
// default light theme on launch.
applyTheme(readStoredTheme());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
