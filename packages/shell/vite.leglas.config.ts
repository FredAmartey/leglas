import { defineConfig, mergeConfig } from "vite";

import base from "./vite.config.ts";

/**
 * The shell as a Leglas preview of itself. The API and its live socket go to a
 * leglas server, and so does everything that isn't the shell, so the previews
 * the inner rail frames resolve instead of hitting vite's 404. LEGLAS_PORT is
 * this vite's port (5180) and LEGLAS_API the server it fronts
 * (http://localhost:4100), so a second copy can run against a scratch project.
 */
const port = Number(process.env["LEGLAS_PORT"] ?? 5180);

const api = process.env["LEGLAS_API"] ?? "http://localhost:4100";

export default mergeConfig(
  base,
  defineConfig({
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
      proxy: {
        "/leglas/api": { changeOrigin: true, target: api, ws: true },
        "^/(?!leglas/|favicon\\.svg$)": { changeOrigin: true, target: api, ws: true },
      },
    },
  }),
);
