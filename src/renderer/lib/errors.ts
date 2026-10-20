import type { AppErrorCode } from "../../shared/errors";
import type { Translate, TranslationKey } from "../i18n";
import { toApiError } from "./api";

export type RecoveryAction = "settings-playback" | "settings-downloads" | "sign-in" | "verify" | "retry";

export interface ErrorDescription {
  code: AppErrorCode;
  title: string;
  detail: string;
  action?: RecoveryAction;
}

const RECOVERY: Partial<Record<AppErrorCode, RecoveryAction>> = {
  LOGIN_REQUIRED: "sign-in",
  LOGIN_EXPIRED: "sign-in",
  PRIVATE_VIDEO: "sign-in",
  CLOUDFLARE_CHALLENGE: "verify",
  MPV_NOT_FOUND: "settings-playback",
  EXTERNAL_PLAYER_NOT_FOUND: "settings-playback",
  EXTERNAL_PLAYER_TEMPLATE: "settings-playback",
  DOWNLOAD_DIRECTORY_REQUIRED: "settings-downloads",
  NETWORK_ERROR: "retry",
  UPDATE_CHECK_FAILED: "retry",
  HTTP_ERROR: "retry",
  INVALID_RESPONSE: "retry"
};

export function describeError(error: unknown, t: Translate): ErrorDescription {
  const apiError = toApiError(error);
  return describeErrorCode(apiError.code, apiError.message, t, apiError.details);
}

/**
 * Errors from the main process carry an English message and, where the UI can
 * explain them itself, a `reason` (plus values such as `status`). A translated
 * `errors.<code>.reasons.<reason>` text wins over the English message.
 */
export function describeErrorCode(
  code: AppErrorCode,
  message: string,
  t: Translate,
  details?: Record<string, string | number>
): ErrorDescription {
  const reason = typeof details?.reason === "string" ? details.reason : undefined;
  const reasonKey = `errors.${code}.reasons.${reason}` as TranslationKey;
  const explained = reason ? t(reasonKey, { ...details, message }) : undefined;
  return {
    code,
    title: t(`errors.${code}.title` as TranslationKey),
    detail: explained && explained !== reasonKey ? explained : t(`errors.${code}.detail` as TranslationKey, { message }),
    action: RECOVERY[code]
  };
}

export function recoveryLabel(action: RecoveryAction, t: Translate): string {
  switch (action) {
    case "settings-playback":
    case "settings-downloads":
      return t("actions.openSettings");
    case "sign-in":
      return t("actions.signIn");
    case "verify":
      return t("actions.verify");
    case "retry":
      return t("actions.retry");
  }
}
