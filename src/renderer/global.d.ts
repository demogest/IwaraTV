import type { IwaraTVBridge } from "./tauri-bridge";

declare global {
  interface Window {
    iwaraTV?: IwaraTVBridge;
  }
}

export {};
