import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // The server mounts the interface under /leglas, so assets must be prefixed
  // or /assets/... is proxied to the user's app.
  base: "/leglas/",
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    // For `vite dev` on the interface itself: proxy the API to a running leglas
    // server for real data.
    proxy: { "/leglas/api": "http://localhost:4100" },
  },
});
