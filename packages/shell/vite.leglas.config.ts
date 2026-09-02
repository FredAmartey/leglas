import { defineConfig, mergeConfig } from "vite";

import base from "./vite.config.ts";

/**
 * The shell as a Leglas preview of itself. The API still goes to the leglas
 * server on 4100, now with its live socket, and everything that is not the
 * shell goes there too, so the previews the inner rail frames resolve through
 * the same server instead of dying on vite's 404.
 */
export default mergeConfig(
  base,
  defineConfig({
    server: {
      host: "127.0.0.1",
      port: 5180,
      strictPort: true,
      proxy: {
        "/leglas/api": { changeOrigin: true, target: "http://localhost:4100", ws: true },
        "^/(?!leglas/|favicon\\.svg$)": {
          changeOrigin: true,
          target: "http://localhost:4100",
          ws: true,
        },
      },
    },
  }),
);
