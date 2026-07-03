// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import React from "react";
import ReactDOM from "react-dom/client";

import { Viewer } from "./Viewer";
import "./viewer.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Viewer />
  </React.StrictMode>,
);
