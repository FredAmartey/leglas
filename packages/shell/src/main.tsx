import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Interface faces, self-hosted through versioned packages rather than
// hand-downloaded files. Satoshi ships with the tool (see index.css).
import "@fontsource-variable/outfit";
import "@fontsource-variable/manrope";
import "@fontsource/spline-sans-mono";

import { App } from "./App.js";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Leglas: #root is missing from the document.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
