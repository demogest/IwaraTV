import type { IwaraTVApi } from "./api";

declare global {
  interface Window {
    iwaraTV?: IwaraTVApi;
  }
}

export {};
