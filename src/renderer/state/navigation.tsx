import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export type Section = "browse" | "search" | "subscriptions" | "favorites" | "downloads" | "history" | "settings";
export type SettingsSection = "general" | "account" | "playback" | "downloads" | "content" | "network" | "advanced";

export interface AuthorRef {
  id: string;
  name?: string;
  username?: string;
  avatarUrl?: string;
  following?: boolean;
}

export type Overlay =
  | { kind: "video"; key: string; videoId: string; title?: string; thumbnailUrl?: string }
  | { kind: "author"; key: string; author: AuthorRef };

/** One-shot requests from other views (e.g. "search for X", "filter Browse by tag"). */
export interface ViewRequest<T> {
  value: T;
  nonce: number;
}

interface NavigationState {
  section: Section;
  stack: Overlay[];
  visited: Section[];
  searchRequest?: ViewRequest<string>;
  browseTagRequest?: ViewRequest<string>;
  settingsRequest?: ViewRequest<SettingsSection>;
}

export interface NavigationActions {
  goTo(section: Section): void;
  openVideo(videoId: string, preview?: { title?: string; thumbnailUrl?: string }): void;
  openAuthor(author: AuthorRef): void;
  back(): void;
  searchFor(query: string): void;
  browseTag(tag: string): void;
  openSettings(section?: SettingsSection): void;
}

interface NavigationValue extends NavigationState, NavigationActions {
  top?: Overlay;
}

const MAX_STACK = 12;
let nonce = 0;
let overlayKey = 0;

const NavigationStateContext = createContext<NavigationState | undefined>(undefined);
const NavigationActionsContext = createContext<NavigationActions | undefined>(undefined);

function visit(visited: Section[], section: Section): Section[] {
  return visited.includes(section) ? visited : [...visited, section];
}

export function NavigationProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<NavigationState>({ section: "browse", stack: [], visited: ["browse"] });

  // Every action uses functional updates, so the actions object never changes.
  const actions = useMemo<NavigationActions>(() => {
    const push = (overlay: Overlay) => {
      setState((current) => {
        const top = current.stack.at(-1);
        const same = top && top.kind === overlay.kind
          && (top.kind === "video"
            ? top.videoId === (overlay as typeof top).videoId
            : top.author.id === (overlay as typeof top).author.id);
        return same ? current : { ...current, stack: [...current.stack, overlay].slice(-MAX_STACK) };
      });
    };
    return {
      goTo: (section) => setState((current) => ({ ...current, section, stack: [], visited: visit(current.visited, section) })),
      openVideo: (videoId, preview) => push({ kind: "video", key: `video-${overlayKey++}`, videoId, ...preview }),
      openAuthor: (author) => push({ kind: "author", key: `author-${overlayKey++}`, author }),
      back: () => setState((current) => (current.stack.length ? { ...current, stack: current.stack.slice(0, -1) } : current)),
      searchFor: (query) => setState((current) => ({
        ...current,
        section: "search",
        stack: [],
        visited: visit(current.visited, "search"),
        searchRequest: { value: query, nonce: ++nonce }
      })),
      browseTag: (tag) => setState((current) => ({
        ...current,
        section: "browse",
        stack: [],
        browseTagRequest: { value: tag, nonce: ++nonce }
      })),
      openSettings: (section) => setState((current) => ({
        ...current,
        section: "settings",
        stack: [],
        visited: visit(current.visited, "settings"),
        settingsRequest: section ? { value: section, nonce: ++nonce } : current.settingsRequest
      }))
    };
  }, []);

  return (
    <NavigationActionsContext.Provider value={actions}>
      <NavigationStateContext.Provider value={state}>{children}</NavigationStateContext.Provider>
    </NavigationActionsContext.Provider>
  );
}

/** Stable navigation actions; using this does not re-render on navigation. */
export function useNavigationActions(): NavigationActions {
  const value = useContext(NavigationActionsContext);
  if (!value) {
    throw new Error("useNavigationActions must be used inside NavigationProvider");
  }
  return value;
}

export function useNavigation(): NavigationValue {
  const state = useContext(NavigationStateContext);
  const actions = useNavigationActions();
  if (!state) {
    throw new Error("useNavigation must be used inside NavigationProvider");
  }
  return useMemo(() => ({ ...state, ...actions, top: state.stack.at(-1) }), [state, actions]);
}
