import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";
import { contentSecurityPolicy } from "./src/shared/csp";

// Injects the Content-Security-Policy meta tag. Development needs inline
// scripts (React refresh preamble) and a websocket to the Vite dev server.
function cspPlugin(): Plugin {
  return {
    name: "iwaratv-csp",
    transformIndexHtml(html, context) {
      const policy = contentSecurityPolicy({ dev: Boolean(context.server) });
      return html.replace(
        "<!-- csp -->",
        `<meta http-equiv="Content-Security-Policy" content="${policy}" />`
      );
    }
  };
}

export default defineConfig({
  main: {
    build: {
      outDir: "out/main"
    }
  },
  preload: {
    build: {
      outDir: "out/preload"
    }
  },
  renderer: {
    root: "src/renderer",
    plugins: [react(), cspPlugin()],
    server: {
      host: "127.0.0.1",
      port: 5174,
      strictPort: true
    },
    build: {
      outDir: "out/renderer",
      minify: true
    }
  }
});
