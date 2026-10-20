import type { PlayerMode } from "../../shared/types";
import type { Translate } from "../i18n";

export function playerName(mode: PlayerMode, t: Translate): string {
  return mode === "builtin" ? t("player.builtin") : mode === "mpv" ? t("player.mpv") : t("player.external");
}

/** "Play here" for the built-in player, "Play in MPV" etc. otherwise. */
export function playLabel(mode: PlayerMode, t: Translate): string {
  return mode === "builtin" ? t("video.playHere") : t("video.playIn", { player: playerName(mode, t) });
}

export const PLAYER_MODES: PlayerMode[] = ["builtin", "mpv", "external"];
