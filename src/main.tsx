import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { isMacOS } from "./utils/platform";

document.documentElement.dataset.platform = isMacOS() ? "macos" : "default";
document.documentElement.dataset.theme = "dark";
document.documentElement.style.colorScheme = "dark";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
