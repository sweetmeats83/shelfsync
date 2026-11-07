import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Served by ShelfSync under /admin/. For `npm run dev`, the API is proxied to a local server.
export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  server: { proxy: { "/admin/api": "http://localhost:8080" } },
  build: { outDir: "dist", sourcemap: false },
});
