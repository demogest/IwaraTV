import type { AppErrorCode, SerializedAppError } from "../../shared/errors";

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly details?: Record<string, string | number>;

  constructor(code: AppErrorCode, message: string, details?: Record<string, string | number>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

export function httpStatusOf(error: unknown): number | undefined {
  if (isAppError(error) && typeof error.details?.status === "number") {
    return error.details.status;
  }
  return undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** Converts any thrown value into the IPC error shape. */
export function serializeError(error: unknown): SerializedAppError {
  if (isAppError(error)) {
    return { code: error.code, message: error.message, details: error.details };
  }

  const message = errorMessage(error);
  const nodeCode = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : undefined;
  if (nodeCode === "ENOENT") {
    return { code: "FILE_NOT_FOUND", message };
  }
  if (nodeCode && ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET"].includes(nodeCode)) {
    return { code: "NETWORK_ERROR", message };
  }
  if (isAbortError(error)) {
    return { code: "NETWORK_ERROR", message: "The request timed out." };
  }
  if (/net::ERR_|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return { code: "NETWORK_ERROR", message };
  }

  return { code: "UNKNOWN", message };
}
