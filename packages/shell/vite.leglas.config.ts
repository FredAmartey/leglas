import { defineConfig, mergeConfig } from "vite";

import base from "./vite.config.ts";

/**
 * The shell as a Leglas preview of itself. The API still goes to a leglas
 * server, now with its live socket, and everything that is not the shell
 * goes there too, so the previews the inner rail frames resolve through the
 * same server instead of dying on vite's 404.
 *
 * LEGLAS_PORT is where this vite listens (5180) and LEGLAS_API the leglas
 * server it fronts (http://localhost:4100), so a second copy can run against
 * a scratch project without another config.
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
