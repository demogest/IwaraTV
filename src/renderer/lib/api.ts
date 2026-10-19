import { isAppErrorCode, type AppErrorCode, type SerializedAppError } from "../../shared/errors";
import type { EventChannel, InvokeArgs, InvokeChannel, InvokeResult, IpcEventContract, IwaraTVBridge } from "../../shared/ipc";

declare global {
  interface Window {
    iwaraTV?: IwaraTVBridge;
  }
}

/** Error thrown by API calls; `code` drives localized messages and recovery actions. */
export class ApiError extends Error {
  readonly code: AppErrorCode;
  readonly details?: Record<string, string | number>;

  constructor(error: SerializedAppError) {
    super(error.message);
    this.name = "ApiError";
    this.code = isAppErrorCode(error.code) ? error.code : "UNKNOWN";
    this.details = error.details;
  }
}

function bridge(): IwaraTVBridge {
  if (!window.iwaraTV) {
    throw new ApiError({ code: "UNKNOWN", message: "The IwaraTV desktop bridge is not available." });
  }
  return window.iwaraTV;
}

export async function invoke<C extends InvokeChannel>(channel: C, ...args: InvokeArgs<C>): Promise<InvokeResult<C>> {
  const response = await bridge().invoke(channel, ...args);
  if (!response.ok) {
    throw new ApiError(response.error);
  }
  return response.data;
}

export function subscribe<E extends EventChannel>(channel: E, listener: (payload: IpcEventContract[E]) => void): () => void {
  return window.iwaraTV ? window.iwaraTV.on(channel, listener) : () => undefined;
}

export function hasBridge(): boolean {
  return Boolean(window.iwaraTV);
}

export function platform(): string {
  return window.iwaraTV?.platform ?? "web";
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  return new ApiError({ code: "UNKNOWN", message: error instanceof Error ? error.message : String(error) });
}
