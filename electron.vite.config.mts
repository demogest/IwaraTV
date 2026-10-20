import { createPublicKey } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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

// The update-signing public key, compiled into the app when committed. With a
// key, the app accepts only update manifests signed by its private half.
function updatePublicKey(): string {
  const file = "build/update-public-key.pem";
  if (!existsSync(file)) {
    return "";
  }
  const pem = readFileSync(file, "utf8");
  if (createPublicKey(pem).asymmetricKeyType !== "ed25519") {
    throw new Error(`${file} must be an Ed25519 public key (npm run update:keygen).`);
  }
  return pem;
}

export default defineConfig({
  main: {
    define: {
      __UPDATE_PUBLIC_KEY__: JSON.stringify(updatePublicKey())
    },
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
