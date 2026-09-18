import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // The server mounts the interface under /leglas, so every asset URL must be
  // prefixed. Without this the built bundle requests /assets/... and gets
  // proxied to the user's app instead.
  base: "/leglas/",
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    // `vite dev` for working on the interface itself: proxy the API to a
    // running leglas server so the shell has real data.
    proxy: { "/leglas/api": "http://localhost:4100" },
  },
});
