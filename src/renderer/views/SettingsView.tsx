import {
  CircleCheck,
  Copy,
  Download,
  FolderOpen,
  Gauge,
  Info,
  Keyboard,
  LogIn,
  LogOut,
  MonitorPlay,
  Network,
  Palette,
  RefreshCw,
  Search,
  ShieldCheck,
  Tag,
  TriangleAlert,
  UserRound,
  Wrench,
  type LucideIcon
} from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { QUALITY_OPTIONS } from "../../shared/defaults";
import { normalizeMediaHostList } from "../../shared/media-hosts";
import { buildExternalPlayerArgs, PLAYER_REFERER_HEADER, templateIncludesUrl } from "../../shared/player-template";
import { splitTagInput } from "../../shared/tags";
import type {
  CardDensity,
  LanguagePreference,
  MediaSpeedTestReport,
  PlayerDiagnostics,
  PlayerMode,
  PlayerProbe,
  RatingFilter,
  ThemePreference
} from "../../shared/types";
import { parseIwaraVideoId } from "../../shared/video-id";
import { ChipInput } from "../components/ChipInput";
import { openShortcuts } from "../components/ShortcutsDialog";
import { Avatar, PageHeader, Segmented, Spinner, Switch, View } from "../components/primitives";
import { useI18n, type TranslationKey } from "../i18n";
import { invoke } from "../lib/api";
import { formatBytes, formatDateTime, formatSpeed, qualityLabel } from "../lib/format";
import { playerName, PLAYER_MODES } from "../lib/player";
import { useAppState } from "../state/app-state";
import { useNavigation, type SettingsSection } from "../state/navigation";
import { useToasts } from "../state/toasts";

const SECTIONS: Array<{ id: SettingsSection; Icon: LucideIcon }> = [
  { id: "general", Icon: Palette },
  { id: "account", Icon: UserRound },
  { id: "playback", Icon: MonitorPlay },
  { id: "downloads", Icon: Download },
  { id: "content", Icon: Tag },
  { id: "network", Icon: Network },
  { id: "advanced", Icon: Wrench }
];

export function SettingsView({ active }: { active: boolean }) {
  const { t } = useI18n();
  const navigation = useNavigation();
  const [section, setSection] = useState<SettingsSection>("general");
  const request = navigation.settingsRequest;

  useEffect(() => {
    if (request) {
      setSection(request.value);
    }
  }, [request]);

  return (
    <View active={active} label={t("settings.title")}>
      <PageHeader subtitle={t("settings.subtitle")} title={t("settings.title")} />
      <div className="settings">
        <nav aria-label={t("settings.title")} className="settings__nav">
          {SECTIONS.map(({ id, Icon }) => (
            <button aria-current={section === id ? "page" : undefined} className="nav-item" key={id} onClick={() => setSection(id)} type="button">
              <Icon aria-hidden="true" size={17} />
              <span className="nav-item__label">{t(`settings.sections.${id}` as TranslationKey)}</span>
            </button>
          ))}
        </nav>
        <div className="settings__content">
          {section === "general" && <GeneralSection />}
          {section === "account" && <AccountSection />}
          {section === "playback" && <PlaybackSection active={active} />}
          {section === "downloads" && <DownloadsSection />}
          {section === "content" && <ContentSection />}
          {section === "network" && <NetworkSection />}
          {section === "advanced" && <AdvancedSection />}
        </div>
      </div>
    </View>
  );
}

// --- Building blocks -------------------------------------------------------------

function Card({ title, description, children }: { title?: string; description?: string; children: ReactNode }) {
  return (
    <section className="settings-card">
      {title && (
        <header className="settings-card__header">
          <h2 className="settings-card__title">{title}</h2>
          {description && <p className="setting__description">{description}</p>}
        </header>
      )}
      {children}
    </section>
  );
}

function Setting({
  label,
  description,
  children,
  stacked,
  labelFor
}: {
  label: string;
  description?: ReactNode;
  children: ReactNode;
  stacked?: boolean;
  labelFor?: string;
}) {
  return (
    <div className={stacked ? "setting setting--stacked" : "setting"}>
      <div className="setting__copy">
        {labelFor ? (
          <label className="setting__label" htmlFor={labelFor}>{label}</label>
        ) : (
          <span className="setting__label">{label}</span>
        )}
        {description && <span className="setting__description">{description}</span>}
      </div>
      <div className="setting__control">{children}</div>
    </div>
  );
}

/** Text field that saves on blur or Enter and reverts on Escape. */
function CommitInput({
  id,
  value,
  onCommit,
  placeholder,
  mono,
  onDraftChange
}: {
  id?: string;
  value: string;
  onCommit: (value: string) => Promise<unknown> | void;
  placeholder?: string;
  mono?: boolean;
  onDraftChange?: (value: string) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(value);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (!saved) {
      return;
    }
    const timer = window.setTimeout(() => setSaved(false), 1600);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const commit = async () => {
    if (draft !== value) {
      await onCommit(draft);
      setSaved(true);
    }
  };

  return (
    <>
      <input
        className="input"
        id={id}
        onBlur={() => void commit()}
        onChange={(event) => {
          setDraft(event.target.value);
          onDraftChange?.(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commit();
          } else if (event.key === "Escape") {
            event.stopPropagation();
            setDraft(value);
            onDraftChange?.(value);
          }
        }}
        placeholder={placeholder}
        spellCheck={false}
        style={mono ? { fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" } : undefined}
        value={draft}
      />
      {saved && <span aria-live="polite" className="saved-indicator">{t("common.saved")}</span>}
    </>
  );
}

function ProbeStatus({ probe }: { probe?: PlayerProbe }) {
  const { t } = useI18n();
  if (!probe) {
    return null;
  }
  return (
    <span className={probe.ok ? "setting__status setting__status--ok" : "setting__status setting__status--bad"}>
      {probe.ok ? <CircleCheck aria-hidden="true" size={15} /> : <TriangleAlert aria-hidden="true" size={15} />}
      {t(`settings.playback.probe.${probe.code}` as TranslationKey, {
        path: probe.resolvedPath ?? probe.configuredPath ?? "",
        detail: probe.detail ?? ""
      })}
    </span>
  );
}

function QualitySelect({ id, value, onChange }: { id: string; value?: string; onChange: (value: string | null) => void }) {
  const { t } = useI18n();
  return (
    <select className="select" id={id} onChange={(event) => onChange(event.target.value || null)} style={{ width: 200 }} value={value ?? ""}>
      <option value="">{t("settings.playback.bestAvailable")}</option>
      {QUALITY_OPTIONS.map((quality) => (
        <option key={quality} value={quality}>
          {qualityLabel(quality)}
        </option>
      ))}
    </select>
  );
}

// --- Sections ----------------------------------------------------------------------

function GeneralSection() {
  const { t } = useI18n();
  const app = useAppState();
  const ui = app.settings.ui;
  return (
    <Card title={t("settings.sections.general")}>
      <Setting description={t("settings.general.languageDesc")} label={t("settings.general.language")}>
        <Segmented<LanguagePreference>
          label={t("settings.general.language")}
          onChange={(language) => void app.updateSettings({ ui: { language } })}
          options={[
            { value: "system", label: t("settings.general.languageSystem") },
            { value: "zh-CN", label: "简体中文" },
            { value: "en", label: "English" }
          ]}
          value={ui.language}
        />
      </Setting>
      <Setting description={t("settings.general.appearanceDesc")} label={t("settings.general.appearance")}>
        <Segmented<ThemePreference>
          label={t("settings.general.appearance")}
          onChange={(theme) => void app.updateSettings({ ui: { theme } })}
          options={[
            { value: "system", label: t("settings.general.themeSystem") },
            { value: "dark", label: t("settings.general.themeDark") },
            { value: "light", label: t("settings.general.themeLight") }
          ]}
          value={ui.theme}
        />
      </Setting>
      <Setting description={t("settings.general.ratingDesc")} label={t("settings.general.rating")}>
        <Segmented<RatingFilter>
          label={t("settings.general.rating")}
          onChange={(rating) => void app.updateSettings({ ui: { rating } })}
          options={[
            { value: "all", label: t("rating.all") },
            { value: "general", label: t("rating.general") },
            { value: "ecchi", label: t("rating.ecchi") }
          ]}
          value={ui.rating}
        />
      </Setting>
      <Setting description={t("settings.general.densityDesc")} label={t("settings.general.density")}>
        <Segmented<CardDensity>
          label={t("settings.general.density")}
          onChange={(density) => void app.updateSettings({ ui: { density } })}
          options={[
            { value: "comfortable", label: t("settings.general.densityComfortable") },
            { value: "compact", label: t("settings.general.densityCompact") }
          ]}
          value={ui.density}
        />
      </Setting>
      <Setting description={t("settings.general.shortcutsDesc")} label={t("settings.general.shortcuts")}>
        <button className="button" onClick={openShortcuts} type="button">
          <Keyboard aria-hidden="true" size={16} />
          {t("settings.general.shortcutsOpen")}
        </button>
      </Setting>
    </Card>
  );
}

function AccountSection() {
  const { t, locale } = useI18n();
  const app = useAppState();
  const auth = app.auth;
  const title = auth.status === "signed-in"
    ? auth.username ? t("settings.account.statusSignedIn", { name: auth.username }) : t("settings.account.statusSignedInAnonymous")
    : auth.status === "verified"
      ? t("settings.account.statusVerified")
      : t("settings.account.statusAnonymous");

  return (
    <>
      <Card>
        <div className="account-status">
          <Avatar name={auth.status === "signed-in" ? auth.username : "?"} size={56} url={auth.avatarUrl} />
          <div className="account-status__copy">
            <span className="account-status__title">{app.authLoading && auth.status === "anonymous" ? t("account.checking") : title}</span>
            <span className="subtle">
              {t("settings.account.cookies", { count: auth.siteCookieCount })}
              {" · "}
              {t("settings.account.token")}: {auth.siteTokenReady ? t("settings.account.tokenFound", { key: auth.siteTokenKey ?? "" }) : t("settings.account.tokenMissing")}
              {auth.tokenExpiresAt ? ` · ${t("settings.account.expires", { date: formatDateTime(auth.tokenExpiresAt, locale) })}` : ""}
            </span>
          </div>
          {auth.status === "signed-in" ? <span className="badge badge--accent">{t("account.signedIn")}</span> : null}
        </div>
        <div className="setting setting--stacked">
          <p className="setting__description">{t("settings.account.body")}</p>
          <div className="setting__control" style={{ justifyContent: "flex-start" }}>
            {auth.status !== "signed-in" && (
              <button className="button button--primary" disabled={auth.verificationWindowOpen} onClick={() => void app.signIn()} type="button" style={{ flex: "0 0 auto" }}>
                <LogIn aria-hidden="true" size={16} />
                {auth.verificationWindowOpen ? t("settings.account.signInOpen") : t("settings.account.signIn")}
              </button>
            )}
            <button className="button" disabled={app.authLoading} onClick={() => void app.refreshAuth()} type="button" style={{ flex: "0 0 auto" }}>
              {app.authLoading ? <Spinner /> : <RefreshCw aria-hidden="true" size={16} />}
              {t("settings.account.refresh")}
            </button>
            {(auth.status !== "anonymous" || auth.siteCookieCount > 0) && (
              <button className="button button--danger-ghost" onClick={() => void app.signOut()} type="button" style={{ flex: "0 0 auto" }}>
                <LogOut aria-hidden="true" size={16} />
                {t("settings.account.signOut")}
              </button>
            )}
          </div>
        </div>
      </Card>
    </>
  );
}

function usePlayerDiagnostics(active: boolean) {
  const app = useAppState();
  const [diagnostics, setDiagnostics] = useState<PlayerDiagnostics>();
  const player = app.settings.player;
  useEffect(() => {
    if (active) {
      void invoke("player:probe").then(setDiagnostics).catch(() => undefined);
    }
  }, [active, player.mpvPath, player.externalPlayerPath, player.externalPlayerArgs]);
  return diagnostics;
}

function PlaybackSection({ active }: { active: boolean }) {
  const { t } = useI18n();
  const app = useAppState();
  const player = app.settings.player;
  const diagnostics = usePlayerDiagnostics(active);
  const [mpvTest, setMpvTest] = useState<PlayerProbe>();
  const [testing, setTesting] = useState(false);
  const [argsDraft, setArgsDraft] = useState(player.externalPlayerArgs);
  const ids = { quality: useId(), mpv: useId(), external: useId(), args: useId() };

  useEffect(() => setArgsDraft(player.externalPlayerArgs), [player.externalPlayerArgs]);

  let preview = "";
  let previewError = "";
  try {
    preview = buildExternalPlayerArgs(argsDraft, { url: "https://…/video.mp4", title: "Title", headers: PLAYER_REFERER_HEADER })
      .map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))
      .join(" ");
    if (!templateIncludesUrl(argsDraft)) {
      previewError = t("settings.playback.probe.missing-url-placeholder");
    }
  } catch (error) {
    previewError = error instanceof Error ? error.message : String(error);
  }

  const choose = async (kind: "mpv" | "external") => {
    try {
      const result = await invoke("system:select-executable", {
        title: kind === "mpv" ? t("settings.playback.mpvPath") : t("settings.playback.externalPath"),
        currentPath: kind === "mpv" ? player.mpvPath : player.externalPlayerPath
      });
      if (!result.canceled && result.path) {
        await app.updateSettings({ player: kind === "mpv" ? { mpvPath: result.path } : { externalPlayerPath: result.path } });
      }
    } catch (error) {
      app.reportError(error);
    }
  };

  const insertPlaceholder = (placeholder: string) => {
    const next = `${argsDraft.trim()} ${placeholder}`.trim();
    setArgsDraft(next);
    void app.updateSettings({ player: { externalPlayerArgs: next } });
  };

  return (
    <>
      <Card description={t("settings.playback.builtinNote")} title={t("settings.sections.playback")}>
        <Setting description={t("settings.playback.playerDesc")} label={t("settings.playback.player")}>
          <Segmented<PlayerMode>
            label={t("settings.playback.player")}
            onChange={(preferredMode) => void app.updateSettings({ player: { preferredMode } })}
            options={PLAYER_MODES.map((mode) => ({ value: mode, label: mode === "builtin" ? t("settings.playback.builtinOption") : playerName(mode, t) }))}
            value={player.preferredMode}
          />
        </Setting>
        <Setting description={t("settings.playback.qualityDesc")} label={t("settings.playback.quality")} labelFor={ids.quality}>
          <QualitySelect id={ids.quality} onChange={(preferredQuality) => void app.updateSettings({ player: { preferredQuality } })} value={player.preferredQuality} />
        </Setting>
      </Card>

      <Card title={t("settings.playback.mpvTitle")}>
        <Setting description={t("settings.playback.mpvPathDesc")} label={t("settings.playback.mpvPath")} labelFor={ids.mpv} stacked>
          <div className="path-field">
            <CommitInput
              id={ids.mpv}
              mono
              onCommit={(value) => app.updateSettings({ player: { mpvPath: value.trim() || null } })}
              placeholder={t("settings.playback.mpvPlaceholder")}
              value={player.mpvPath ?? ""}
            />
            <button className="button" onClick={() => void choose("mpv")} type="button">
              <FolderOpen aria-hidden="true" size={16} />
              {t("common.choose")}
            </button>
          </div>
        </Setting>
        <div className="setting">
          <div className="setting__copy">
            <ProbeStatus probe={mpvTest ?? diagnostics?.mpv} />
          </div>
          <div className="setting__control">
            <button
              className="button"
              disabled={testing}
              onClick={() => {
                setTesting(true);
                void invoke("player:test-mpv").then(setMpvTest).catch(app.reportError).finally(() => setTesting(false));
              }}
              type="button"
            >
              {testing ? <Spinner /> : <MonitorPlay aria-hidden="true" size={16} />}
              {t("settings.playback.testMpv")}
            </button>
          </div>
        </div>
      </Card>

      <Card title={t("settings.playback.externalTitle")}>
        <Setting description={t("settings.playback.externalPathDesc")} label={t("settings.playback.externalPath")} labelFor={ids.external} stacked>
          <div className="path-field">
            <CommitInput
              id={ids.external}
              mono
              onCommit={(value) => app.updateSettings({ player: { externalPlayerPath: value.trim() || null } })}
              placeholder={t("settings.playback.externalPlaceholder")}
              value={player.externalPlayerPath ?? ""}
            />
            <button className="button" onClick={() => void choose("external")} type="button">
              <FolderOpen aria-hidden="true" size={16} />
              {t("common.choose")}
            </button>
          </div>
        </Setting>
        <Setting description={t("settings.playback.externalArgsDesc")} label={t("settings.playback.externalArgs")} labelFor={ids.args} stacked>
          <div style={{ display: "grid", gap: 8 }}>
            <CommitInput
              id={ids.args}
              mono
              onCommit={(value) => app.updateSettings({ player: { externalPlayerArgs: value } })}
              onDraftChange={setArgsDraft}
              value={player.externalPlayerArgs}
            />
            <div className="chip-list">
              {["{url}", "{title}", "{headers}"].map((placeholder) => (
                <button className="chip" key={placeholder} onClick={() => insertPlaceholder(placeholder)} type="button">
                  {t("settings.playback.insertPlaceholder", { name: placeholder })}
                </button>
              ))}
            </div>
            <span className="setting__label" style={{ fontSize: "var(--text-xs)" }}>{t("settings.playback.preview")}</span>
            <pre className="code-preview">{player.externalPlayerPath ?? "player"} {preview}</pre>
            {previewError && (
              <span className="setting__status setting__status--bad">
                <TriangleAlert aria-hidden="true" size={15} />
                {previewError}
              </span>
            )}
          </div>
        </Setting>
        <div className="setting">
          <ProbeStatus probe={diagnostics?.external} />
        </div>
      </Card>
    </>
  );
}

function DownloadsSection() {
  const { t, locale } = useI18n();
  const app = useAppState();
  const download = app.settings.download;
  const ids = { folder: useId(), quality: useId(), threshold: useId() };

  const choose = async () => {
    try {
      const result = await invoke("system:select-directory", { title: t("settings.downloads.folder"), currentPath: download.directory });
      if (!result.canceled && result.path) {
        await app.updateSettings({ download: { directory: result.path } });
      }
    } catch (error) {
      app.reportError(error);
    }
  };

  return (
    <Card title={t("settings.sections.downloads")} description={t("settings.downloads.resumeNote")}>
      <Setting description={t("settings.downloads.folderDesc")} label={t("settings.downloads.folder")} labelFor={ids.folder} stacked>
        <div className="path-field">
          <CommitInput
            id={ids.folder}
            mono
            onCommit={(value) => app.updateSettings({ download: { directory: value.trim() || null } })}
            value={download.directory ?? ""}
          />
          <button className="button" onClick={() => void choose()} type="button">
            <FolderOpen aria-hidden="true" size={16} />
            {t("common.choose")}
          </button>
          <button className="button" onClick={() => void invoke("downloads:open-directory").catch(app.reportError)} type="button">
            {t("common.open")}
          </button>
        </div>
      </Setting>
      <Setting description={t("settings.downloads.qualityDesc")} label={t("settings.downloads.quality")} labelFor={ids.quality}>
        <QualitySelect id={ids.quality} onChange={(defaultQuality) => void app.updateSettings({ download: { defaultQuality } })} value={download.defaultQuality} />
      </Setting>
      <Setting description={t("settings.downloads.connectionsDesc")} label={t("settings.downloads.connections")}>
        <Segmented<number>
          label={t("settings.downloads.connections")}
          onChange={(maxConnections) => void app.updateSettings({ download: { maxConnections } })}
          options={[1, 2, 4, 6, 8].map((value) => ({ value, label: String(value) }))}
          value={download.maxConnections}
        />
      </Setting>
      <Setting label={t("settings.downloads.threshold")} labelFor={ids.threshold}>
        <select
          className="select"
          id={ids.threshold}
          onChange={(event) => void app.updateSettings({ download: { minSplitBytes: Number(event.target.value) } })}
          style={{ width: 140 }}
          value={download.minSplitBytes}
        >
          {[1, 8, 16, 32, 64].map((megabytes) => (
            <option key={megabytes} value={megabytes * 1024 * 1024}>
              {formatBytes(megabytes * 1024 * 1024, locale)}
            </option>
          ))}
        </select>
      </Setting>
      <Setting description={t("settings.downloads.notifyDesc")} label={t("settings.downloads.notify")}>
        <Switch
          checked={download.notifyOnComplete}
          label={t("settings.downloads.notify")}
          onChange={(notifyOnComplete) => void app.updateSettings({ download: { notifyOnComplete } })}
        />
      </Setting>
    </Card>
  );
}

function ContentSection() {
  const { t } = useI18n();
  const app = useAppState();
  const tags = app.settings.tagPreferences;
  const ids = { pages: useId(), delay: useId() };

  return (
    <Card title={t("settings.sections.content")}>
      <Setting description={t("settings.content.followedDesc")} label={t("settings.content.followed")} stacked>
        <ChipInput
          label={t("settings.content.followed")}
          onChange={(followedTags) => void app.updateSettings({ tagPreferences: { followedTags } })}
          placeholder={t("settings.content.addTag")}
          removeLabel={(tag) => `${t("common.remove")} ${tag}`}
          split={splitTagInput}
          tone="accent"
          values={tags.followedTags}
        />
      </Setting>
      <Setting description={t("settings.content.blockedDesc")} label={t("settings.content.blocked")} stacked>
        <ChipInput
          label={t("settings.content.blocked")}
          onChange={(blockedTags) => void app.updateSettings({ tagPreferences: { blockedTags } })}
          placeholder={t("settings.content.addTag")}
          removeLabel={(tag) => `${t("common.remove")} ${tag}`}
          split={splitTagInput}
          tone="danger"
          values={tags.blockedTags}
        />
      </Setting>
      <Setting description={t("settings.content.scanPagesDesc")} label={t("settings.content.scanPages")} labelFor={ids.pages}>
        <select
          className="select"
          id={ids.pages}
          onChange={(event) => void app.updateSettings({ tagPreferences: { maxScanPages: Number(event.target.value) } })}
          style={{ width: 140 }}
          value={tags.maxScanPages}
        >
          {[1, 3, 5, 8, 10].map((pages) => (
            <option key={pages} value={pages}>{t("settings.content.pages", { count: pages })}</option>
          ))}
        </select>
      </Setting>
      <Setting description={t("settings.content.delayDesc")} label={t("settings.content.delay")} labelFor={ids.delay}>
        <select
          className="select"
          id={ids.delay}
          onChange={(event) => void app.updateSettings({ tagPreferences: { requestDelayMs: Number(event.target.value) } })}
          style={{ width: 140 }}
          value={tags.requestDelayMs}
        >
          <option value={0}>{t("settings.content.noDelay")}</option>
          {[250, 500, 1000, 1500].map((ms) => (
            <option key={ms} value={ms}>{ms} ms</option>
          ))}
        </select>
      </Setting>
    </Card>
  );
}

function NetworkSection() {
  const { t, locale } = useI18n();
  const app = useAppState();
  const { push } = useToasts();
  const media = app.settings.mediaSpeed;
  const [videoInput, setVideoInput] = useState(app.settings.history[0]?.video.id ?? "");
  const [testing, setTesting] = useState(false);
  const [report, setReport] = useState<MediaSpeedTestReport>();
  const ids = { bytes: useId(), timeout: useId(), video: useId() };

  const runSpeedTest = async () => {
    setTesting(true);
    try {
      const result = await invoke("iwara:speed-test-video", videoInput.trim());
      setReport(result);
      push({
        tone: result.fastestHost ? "success" : "info",
        title: result.fastestHost ? t("settings.network.speedTestDone", { host: result.fastestHost }) : t("settings.network.speedTestNone")
      });
    } catch (error) {
      app.reportError(error, () => void runSpeedTest());
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <Card title={t("settings.sections.network")}>
        <Setting description={t("settings.network.replaceDesc")} label={t("settings.network.replace")}>
          <Switch checked={media.replaceLinks} label={t("settings.network.replace")} onChange={(replaceLinks) => void app.updateSettings({ mediaSpeed: { replaceLinks } })} />
        </Setting>
        <Setting description={t("settings.network.autoTestDesc")} label={t("settings.network.autoTest")}>
          <Switch checked={media.autoTest} label={t("settings.network.autoTest")} onChange={(autoTest) => void app.updateSettings({ mediaSpeed: { autoTest } })} />
        </Setting>
        <Setting
          description={media.lastTestedAt ? t("settings.network.testedAt", { date: formatDateTime(media.lastTestedAt, locale) }) : undefined}
          label={t("settings.network.ranking")}
          stacked
        >
          {media.rankedHosts.length ? (
            <ol className="ranking">
              {media.rankedHosts.map((host, index) => (
                <li key={host}>
                  <span className="ranking__index">{index + 1}</span>
                  {host}
                </li>
              ))}
            </ol>
          ) : (
            <span className="subtle">{t("settings.network.notRanked")}</span>
          )}
        </Setting>
      </Card>

      <Card title={t("settings.network.speedTest")} description={t("settings.network.speedTestDesc")}>
        <div className="setting setting--stacked">
          <form
            className="path-field"
            onSubmit={(event) => {
              event.preventDefault();
              void runSpeedTest();
            }}
          >
            <input
              aria-label={t("settings.network.speedTestInput")}
              className="input"
              id={ids.video}
              onChange={(event) => setVideoInput(event.target.value)}
              placeholder={t("settings.network.speedTestInput")}
              value={videoInput}
            />
            <button className="button button--primary" disabled={testing || !parseIwaraVideoId(videoInput)} type="submit">
              {testing ? <Spinner /> : <Gauge aria-hidden="true" size={16} />}
              {t("settings.network.speedTest")}
            </button>
          </form>
          {report && (
            <ul className="kv-list">
              {[...report.results]
                .sort((a, b) => (b.bytesPerSecond ?? 0) - (a.bytesPerSecond ?? 0))
                .map((result) => (
                  <li className={result.ok ? undefined : "is-error"} key={result.host}>
                    {result.host}: {result.ok ? formatSpeed(result.bytesPerSecond, locale) : result.error}
                  </li>
                ))}
            </ul>
          )}
        </div>
        <Setting label={t("settings.network.sampleSize")} labelFor={ids.bytes}>
          <select
            className="select"
            id={ids.bytes}
            onChange={(event) => void app.updateSettings({ mediaSpeed: { testBytes: Number(event.target.value) } })}
            style={{ width: 140 }}
            value={media.testBytes}
          >
            {[262_144, 524_288, 1_048_576].map((bytes) => (
              <option key={bytes} value={bytes}>{formatBytes(bytes, locale)}</option>
            ))}
          </select>
        </Setting>
        <Setting label={t("settings.network.timeout")} labelFor={ids.timeout}>
          <select
            className="select"
            id={ids.timeout}
            onChange={(event) => void app.updateSettings({ mediaSpeed: { timeoutMs: Number(event.target.value) } })}
            style={{ width: 140 }}
            value={media.timeoutMs}
          >
            {[3000, 4500, 7000, 10_000].map((ms) => (
              <option key={ms} value={ms}>{t("settings.network.seconds", { value: ms / 1000 })}</option>
            ))}
          </select>
        </Setting>
      </Card>

      <Card title={t("settings.network.hosts")} description={t("settings.network.hostsDesc")}>
        <div className="setting setting--stacked">
          <ChipInput
            label={t("settings.network.hosts")}
            onChange={(candidateHosts) => void app.updateSettings({ mediaSpeed: { candidateHosts } })}
            placeholder={t("settings.network.addHost")}
            removeLabel={(host) => `${t("common.remove")} ${host}`}
            split={(text) => normalizeMediaHostList(text.split(/[\s,;，；]+/))}
            values={media.candidateHosts}
          />
          <div className="setting__control" style={{ justifyContent: "flex-start" }}>
            <button
              className="button"
              disabled={!media.candidateHosts.length}
              onClick={() => {
                void invoke("system:write-clipboard", media.candidateHosts.join("\n"))
                  .then(() => push({ tone: "success", title: t("settings.network.hostsCopied", { count: media.candidateHosts.length }) }))
                  .catch(app.reportError);
              }}
              style={{ flex: "0 0 auto" }}
              type="button"
            >
              <Copy aria-hidden="true" size={16} />
              {t("settings.network.copyHosts")}
            </button>
          </div>
        </div>
      </Card>
    </>
  );
}

function AdvancedSection() {
  const { t, locale } = useI18n();
  const app = useAppState();
  const { push } = useToasts();
  const iwara = app.settings.iwara;
  const info = app.appInfo;
  const [sniffing, setSniffing] = useState(false);
  const saltId = useId();

  const sniff = async () => {
    setSniffing(true);
    try {
      const report = await invoke("iwara:sniff-x-version-salt");
      push({ tone: "success", title: t("settings.advanced.sniffed", { salt: report.salt }) });
    } catch (error) {
      app.reportError(error, () => void sniff());
    } finally {
      setSniffing(false);
    }
  };

  return (
    <>
      <Card title={t("settings.advanced.salt")} description={t("settings.advanced.saltDesc")}>
        <Setting description={t("settings.advanced.autoSniffDesc")} label={t("settings.advanced.autoSniff")}>
          <Switch
            checked={iwara.autoSniffXVersionSalt}
            label={t("settings.advanced.autoSniff")}
            onChange={(autoSniffXVersionSalt) => void app.updateSettings({ iwara: { autoSniffXVersionSalt } })}
          />
        </Setting>
        <Setting
          description={iwara.lastSaltSniffAt ? t("settings.advanced.lastSniff", { date: formatDateTime(iwara.lastSaltSniffAt, locale) }) : undefined}
          label={t("settings.advanced.salt")}
          labelFor={saltId}
          stacked
        >
          <div className="path-field">
            <CommitInput
              id={saltId}
              mono
              onCommit={(value) => app.updateSettings({ iwara: { xVersionSalt: value.trim() } })}
              value={iwara.xVersionSalt}
            />
            <button className="button" disabled={sniffing} onClick={() => void sniff()} type="button">
              {sniffing ? <Spinner /> : <Search aria-hidden="true" size={16} />}
              {t("settings.advanced.sniff")}
            </button>
          </div>
        </Setting>
      </Card>

      <Card title={t("settings.advanced.about")}>
        {info?.migratedFrom && (
          <div className="setting setting--stacked">
            <div className="inline-notice inline-notice--success">
              <ShieldCheck aria-hidden="true" size={16} />
              <span>{t("settings.advanced.migrated")}</span>
            </div>
          </div>
        )}
        <Setting label={t("settings.advanced.version")}>
          <span className="mono">{info ? `${info.name} ${info.version}` : "—"}</span>
        </Setting>
        <Setting label={t("settings.advanced.runtime")}>
          <span className="mono subtle">
            {info ? `Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node} · ${info.platform}-${info.arch}` : "—"}
          </span>
        </Setting>
        <Setting label={t("settings.advanced.dataFolder")} stacked>
          <div className="path-field">
            <input aria-label={t("settings.advanced.dataFolder")} className="input" readOnly value={info?.userDataPath ?? ""} />
            <button
              aria-label={t("common.copy")}
              className="button button--icon"
              disabled={!info}
              onClick={() => info && void app.copyText(info.userDataPath)}
              title={t("common.copy")}
              type="button"
            >
              <Copy aria-hidden="true" size={16} />
            </button>
          </div>
        </Setting>
        <div className="setting setting--stacked">
          <span className="subtle" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Info aria-hidden="true" size={14} />
            {t("app.disclaimer")}
          </span>
        </div>
      </Card>
    </>
  );
}
