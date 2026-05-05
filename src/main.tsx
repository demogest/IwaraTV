import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { installTauriApi } from "./tauri/api";
import "./styles.css";

installTauriApi();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
