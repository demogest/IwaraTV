import { ArrowLeft, Keyboard, PlugZap } from "lucide-react";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { Omnibox } from "./components/Omnibox";
import { openShortcuts, ShortcutsDialog } from "./components/ShortcutsDialog";
import { StateMessage } from "./components/primitives";
import { Sidebar } from "./components/Sidebar";
import { ToastRegion } from "./components/Toasts";
import { UpdateDialog } from "./components/UpdateDialog";
import { useHotkeys } from "./hooks/useHotkeys";
import { useI18n } from "./i18n";
import { hasBridge } from "./lib/api";
import { useAppState } from "./state/app-state";
import { useNavigation, type Section } from "./state/navigation";
import { AuthorView } from "./views/AuthorView";
import { BrowseView } from "./views/BrowseView";
import { DownloadsView } from "./views/DownloadsView";
import { FavoritesView } from "./views/FavoritesView";
import { HistoryView } from "./views/HistoryView";
import { HomeView } from "./views/HomeView";
import { SearchView } from "./views/SearchView";
import { SettingsView } from "./views/SettingsView";
import { SubscriptionsView } from "./views/SubscriptionsView";
import { VideoView } from "./views/VideoView";

const SECTION_VIEWS: Record<Section, ComponentType<{ active: boolean }>> = {
  home: HomeView,
  browse: BrowseView,
  search: SearchView,
  subscriptions: SubscriptionsView,
  favorites: FavoritesView,
  downloads: DownloadsView,
  history: HistoryView,
  settings: SettingsView
};

const NARROW_WIDTH = 1080;
/** Sidebar order, for Ctrl/⌘+1…7. */
const SECTION_ORDER: Section[] = ["home", "browse", "search", "subscriptions", "favorites", "downloads", "history"];

function readCollapsed(): boolean {
  try {
    const stored = localStorage.getItem("iwaratv.sidebarCollapsed");
    return stored === null ? window.innerWidth < NARROW_WIDTH : stored === "true";
  } catch {
    return window.innerWidth < NARROW_WIDTH;
  }
}

export function App() {
  const { t } = useI18n();
  const navigation = useNavigation();
  const density = useAppState().settings.ui.density;
  const omniboxRef = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState(readCollapsed);

  useEffect(() => {
    try {
      localStorage.setItem("iwaratv.sidebarCollapsed", String(collapsed));
    } catch {
      // Remembering the sidebar state is optional.
    }
  }, [collapsed]);

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${NARROW_WIDTH}px)`);
    const onChange = (event: MediaQueryListEvent) => setCollapsed(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useHotkeys({
    focusSearch: () => {
      omniboxRef.current?.focus();
      omniboxRef.current?.select();
    },
    back: navigation.back,
    openSettings: () => navigation.openSettings(),
    goToSection: (index) => {
      const section = SECTION_ORDER[index];
      if (section) {
        navigation.goTo(section);
      }
    },
    showShortcuts: openShortcuts
  });

  if (!hasBridge()) {
    return (
      <StateMessage Icon={PlugZap} body={t("app.bridgeMissingBody")} title={t("app.bridgeMissingTitle")} tone="error" />
    );
  }

  const top = navigation.top;

  return (
    <div className={collapsed ? "shell shell--collapsed" : "shell"} data-density={density}>
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((value) => !value)} />
      <div className="main">
        <header className="topbar">
          {navigation.stack.length > 0 && (
            <button className="button button--ghost topbar__back" onClick={navigation.back} title={`${t("nav.back")} (Alt+←)`} type="button">
              <ArrowLeft aria-hidden="true" size={17} />
              {t("nav.back")}
            </button>
          )}
          <Omnibox ref={omniboxRef} />
          <button
            aria-label={t("shortcuts.title")}
            className="button button--ghost button--icon topbar__help"
            onClick={openShortcuts}
            title={`${t("shortcuts.title")} (?)`}
            type="button"
          >
            <Keyboard aria-hidden="true" size={18} />
          </button>
        </header>
        <main className="views">
          {navigation.visited.map((section) => {
            const SectionView = SECTION_VIEWS[section];
            return <SectionView active={!top && navigation.section === section} key={section} />;
          })}
          {navigation.stack.map((overlay) =>
            overlay.kind === "video" ? (
              <VideoView
                active={overlay === top}
                key={overlay.key}
                thumbnailUrl={overlay.thumbnailUrl}
                title={overlay.title}
                videoId={overlay.videoId}
              />
            ) : (
              <AuthorView active={overlay === top} author={overlay.author} key={overlay.key} />
            )
          )}
        </main>
      </div>
      <ToastRegion />
      <ShortcutsDialog />
      <UpdateDialog />
    </div>
  );
}
