import type { IwaraTVBridge } from "../main/preload";

declare global {
  interface Window {
    iwaraTV?: IwaraTVBridge;
  }
}

export {};

