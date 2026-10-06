import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "SRV_");
  const apiTarget = env.SRV_API_TARGET || "http://127.0.0.1:8000";
  return {
    base: command === "build" ? "/static/" : "/",
    plugins: [react()],
    server: {
      proxy: {
        "/api": apiTarget,
        "/static": apiTarget,
      },
    },
    build: {
      outDir: "../static",
      emptyOutDir: false,
    },
  };
});
