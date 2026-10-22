import { Bell, CircleArrowUp, Compass, Download, History, House, PanelLeftClose, PanelLeftOpen, Search, Settings, Star, type LucideIcon } from "lucide-react";
import logoUrl from "../assets/iwara-tv-mark.svg";
import { useI18n, type TranslationKey } from "../i18n";
import { useAppState, useDownloads } from "../state/app-state";
import { useNavigation, type Section } from "../state/navigation";
import { useUpdates } from "../state/updates";
import { Avatar } from "./primitives";

interface NavEntry {
  section: Section;
  label: TranslationKey;
  Icon: LucideIcon;
}

const DISCOVER: NavEntry[] = [
  { section: "home", label: "nav.home", Icon: House },
  { section: "browse", label: "nav.browse", Icon: Compass },
  { section: "search", label: "nav.search", Icon: Search },
  { section: "subscriptions", label: "nav.subscriptions", Icon: Bell }
];

const LIBRARY: NavEntry[] = [
  { section: "favorites", label: "nav.favorites", Icon: Star },
  { section: "downloads", label: "nav.downloads", Icon: Download },
  { section: "history", label: "nav.history", Icon: History }
];

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  const navigation = useNavigation();
  const app = useAppState();
  const downloads = useDownloads();
  const updates = useUpdates();
  const activeCount = downloads.active.length;

  const item = ({ section, label, Icon }: NavEntry) => {
    const current = navigation.section === section;
    const badge = section === "downloads" && activeCount > 0 ? activeCount : undefined;
    return (
      <button
        aria-current={current ? "page" : undefined}
        aria-label={collapsed ? t(label) : undefined}
        className="nav-item"
        key={section}
        onClick={() => navigation.goTo(section)}
        title={collapsed ? t(label) : undefined}
        type="button"
      >
        <Icon aria-hidden="true" size={19} />
        <span className="nav-item__label">{t(label)}</span>
        {badge !== undefined && (
          <span aria-label={t("nav.activeDownloads", { count: badge })} className="nav-item__badge">
            {badge}
          </span>
        )}
      </button>
    );
  };

  const status = app.authLoading && app.auth.status === "anonymous"
    ? t("account.checking")
    : app.auth.status === "signed-in"
      ? t("account.signedIn")
      : app.auth.status === "verified"
        ? t("account.verified")
        : t("account.anonymous");
  const name = app.auth.status === "signed-in" ? app.auth.username ?? t("account.signedIn") : t("account.guest");
  const progress = updates.state.progress;
  const updateLabel = updates.state.status === "downloading"
    ? t("updates.downloadingShort", { percent: progress?.total ? Math.round((progress.received / progress.total) * 100) : 0 })
    : updates.state.status === "ready"
      ? updates.state.strategy === "automatic" ? t("updates.restart") : t("updates.ready")
      : t("updates.available");
  const updateTitle = updates.state.update ? `${updateLabel} · ${updates.state.update.version}` : updateLabel;

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <img alt="" className="sidebar__logo" src={logoUrl} />
        <span className="sidebar__name">{t("app.name")}</span>
        <button
          aria-label={collapsed ? t("nav.expand") : t("nav.collapse")}
          className="button button--ghost button--icon button--sm sidebar__collapse"
          onClick={onToggle}
          title={collapsed ? t("nav.expand") : t("nav.collapse")}
          type="button"
        >
          {collapsed ? <PanelLeftOpen aria-hidden="true" size={17} /> : <PanelLeftClose aria-hidden="true" size={17} />}
        </button>
      </div>

      <nav aria-label={t("nav.discover")} className="sidebar__group">
        <span className="sidebar__group-label">{t("nav.discover")}</span>
        {DISCOVER.map(item)}
      </nav>
      <nav aria-label={t("nav.library")} className="sidebar__group">
        <span className="sidebar__group-label">{t("nav.library")}</span>
        {LIBRARY.map(item)}
      </nav>

      <div className="sidebar__footer">
        {updates.visible && (
          <button
            aria-haspopup="dialog"
            aria-label={updateTitle}
            className="nav-item nav-item--update"
            onClick={updates.openDialog}
            title={updateTitle}
            type="button"
          >
            <CircleArrowUp aria-hidden="true" size={19} />
            <span className="nav-item__label">{updateLabel}</span>
            <span className="nav-item__version">{updates.state.update?.version}</span>
          </button>
        )}
        {item({ section: "settings", label: "nav.settings", Icon: Settings })}
        <button
          aria-label={`${name} — ${status}. ${t("account.manage")}`}
          className="account-chip"
          onClick={() => navigation.openSettings("account")}
          title={collapsed ? `${name} — ${status}` : t("account.manage")}
          type="button"
        >
          <span className="account-chip__avatar">
            <Avatar name={app.auth.status === "signed-in" ? name : "?"} size={34} url={app.auth.avatarUrl} />
            <span className={`account-chip__dot account-chip__dot--${app.auth.status}`} />
          </span>
          <span className="account-chip__copy">
            <span className="account-chip__name">{name}</span>
            <span className="account-chip__status">{status}</span>
          </span>
        </button>
      </div>
    </aside>
  );
}
