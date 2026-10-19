import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { contentSecurityPolicy } from "./src/shared/csp";

// Browser-only preview of the renderer with the mock backend
// (src/renderer/dev/mock-bridge.ts). Use `npm run dev` for the real app.
function cspPlugin(): Plugin {
  return {
    name: "iwaratv-csp",
    transformIndexHtml(html) {
      return html.replace("<!-- csp -->", `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy({ dev: true })}" />`);
    }
  };
}

export default defineConfig({
  root: "src/renderer",
  plugins: [react(), cspPlugin()],
  server: {
    host: "127.0.0.1",
    port: 5175,
    strictPort: true
  }
});
