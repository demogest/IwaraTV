import { ArrowLeft, PlugZap } from "lucide-react";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { Omnibox } from "./components/Omnibox";
import { StateMessage } from "./components/primitives";
import { Sidebar } from "./components/Sidebar";
import { ToastRegion } from "./components/Toasts";
import { useHotkeys } from "./hooks/useHotkeys";
import { useI18n } from "./i18n";
import { hasBridge } from "./lib/api";
import { useNavigation, type Section } from "./state/navigation";
import { AuthorView } from "./views/AuthorView";
import { BrowseView } from "./views/BrowseView";
import { DownloadsView } from "./views/DownloadsView";
import { FavoritesView } from "./views/FavoritesView";
import { HistoryView } from "./views/HistoryView";
import { SearchView } from "./views/SearchView";
import { SettingsView } from "./views/SettingsView";
import { SubscriptionsView } from "./views/SubscriptionsView";
import { VideoView } from "./views/VideoView";

const SECTION_VIEWS: Record<Section, ComponentType<{ active: boolean }>> = {
  browse: BrowseView,
  search: SearchView,
  subscriptions: SubscriptionsView,
  favorites: FavoritesView,
  downloads: DownloadsView,
  history: HistoryView,
  settings: SettingsView
};

const NARROW_WIDTH = 1080;

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
    openSettings: () => navigation.openSettings()
  });

  if (!hasBridge()) {
    return (
      <StateMessage Icon={PlugZap} body={t("app.bridgeMissingBody")} title={t("app.bridgeMissingTitle")} tone="error" />
    );
  }

  const top = navigation.top;

  return (
    <div className={collapsed ? "shell shell--collapsed" : "shell"}>
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
    </div>
  );
}
