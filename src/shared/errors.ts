// Machine-readable error codes. The main process attaches one to every error
// it returns so the renderer can localize the message and offer the right
// recovery action without parsing message text.
export const APP_ERROR_CODES = [
  "INVALID_INPUT",
  "INVALID_VIDEO_ID",
  "LOGIN_REQUIRED",
  "LOGIN_EXPIRED",
  "PRIVATE_VIDEO",
  "VIDEO_NOT_FOUND",
  "VIDEO_UNAVAILABLE",
  "CLOUDFLARE_CHALLENGE",
  "HTTP_ERROR",
  "NETWORK_ERROR",
  "INVALID_RESPONSE",
  "NO_FORMATS",
  "MPV_NOT_FOUND",
  "EXTERNAL_PLAYER_NOT_FOUND",
  "EXTERNAL_PLAYER_TEMPLATE",
  "PLAYER_LAUNCH_FAILED",
  "DOWNLOAD_DIRECTORY_REQUIRED",
  "DOWNLOAD_NOT_FOUND",
  "DOWNLOAD_ACTIVE",
  "DOWNLOAD_FAILED",
  "FILE_NOT_FOUND",
  "SALT_NOT_FOUND",
  "FAVORITES_FILE_INVALID",
  "UNKNOWN"
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

export interface SerializedAppError {
  code: AppErrorCode;
  /** English technical message; the renderer prefers a localized text by code. */
  message: string;
  details?: Record<string, string | number>;
}

export function isAppErrorCode(value: unknown): value is AppErrorCode {
  return typeof value === "string" && (APP_ERROR_CODES as readonly string[]).includes(value);
}
