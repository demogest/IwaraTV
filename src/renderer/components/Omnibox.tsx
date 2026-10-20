import { Clipboard, Film, History, Search, Trash2, X } from "lucide-react";
import { forwardRef, useId, useMemo, useState } from "react";
import { classifyOmniboxInput } from "../../shared/video-id";
import { useI18n } from "../i18n";
import { hasBridge, invoke } from "../lib/api";
import { clearRecentSearches, readRecentSearches, removeRecentSearch } from "../lib/recent-searches";
import { useNavigationActions } from "../state/navigation";

interface Option {
  kind: "video" | "search" | "clipboard" | "recent" | "clear-recent";
  label: string;
  value: string;
}

const ICONS = { video: Film, search: Search, clipboard: Clipboard, recent: History, "clear-recent": Trash2 };

/**
 * The top search box. A pasted Iwara link or video ID opens the video; any
 * other text searches. When a single token could be either, both choices are
 * offered and the more likely one is preselected.
 */
export const Omnibox = forwardRef<HTMLInputElement>(function Omnibox(_props, ref) {
  const { t } = useI18n();
  const navigation = useNavigationActions();
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const [clipboardId, setClipboardId] = useState<string>();
  const listId = useId();

  const options = useMemo<Option[]>(() => {
    if (!value.trim()) {
      // Empty box: a copied Iwara link, then recent searches.
      const suggestions: Option[] = clipboardId
        ? [{ kind: "clipboard", label: t("omnibox.clipboard", { id: clipboardId }), value: clipboardId }]
        : [];
      suggestions.push(...recent.map((query): Option => ({ kind: "recent", label: query, value: query })));
      if (recent.length) {
        suggestions.push({ kind: "clear-recent", label: t("omnibox.clearRecent"), value: "" });
      }
      return suggestions;
    }
    const intent = classifyOmniboxInput(value);
    switch (intent.kind) {
      case "video":
        return [{ kind: "video", label: t("omnibox.openVideo", { id: intent.videoId }), value: intent.videoId }];
      case "search":
        return [{ kind: "search", label: t("omnibox.search", { query: intent.query }), value: intent.query }];
      case "ambiguous": {
        const video: Option = { kind: "video", label: t("omnibox.openVideo", { id: intent.videoId }), value: intent.videoId };
        const search: Option = { kind: "search", label: t("omnibox.search", { query: intent.query }), value: intent.query };
        return intent.preferVideo ? [video, search] : [search, video];
      }
      default:
        return [];
    }
  }, [value, t, recent, clipboardId]);

  const empty = !value.trim();
  const showList = focused && (empty ? options.length > 0 : options.length > 1);
  const selected = options[Math.min(activeIndex, options.length - 1)];

  const run = (option: Option | undefined) => {
    if (!option) {
      return;
    }
    if (option.kind === "clear-recent") {
      clearRecentSearches();
      setRecent([]);
      setActiveIndex(0);
      return;
    }
    if (option.kind === "video" || option.kind === "clipboard") {
      navigation.openVideo(option.value);
      setValue("");
    } else {
      navigation.searchFor(option.value);
      if (option.kind === "recent") {
        setValue(option.value);
      }
    }
    setActiveIndex(0);
    (document.activeElement as HTMLElement | null)?.blur();
  };

  return (
    <div className="omnibox">
      <form
        className="omnibox__field"
        onSubmit={(event) => {
          event.preventDefault();
          run(selected);
        }}
        role="search"
      >
        <Search aria-hidden="true" size={17} />
        <input
          aria-activedescendant={showList ? `${listId}-${activeIndex}` : undefined}
          aria-autocomplete="list"
          aria-controls={showList ? listId : undefined}
          aria-expanded={showList}
          aria-label={t("omnibox.label")}
          className="omnibox__input"
          onBlur={() => setFocused(false)}
          onChange={(event) => {
            setValue(event.target.value);
            setActiveIndex(0);
          }}
          onFocus={() => {
            setFocused(true);
            setRecent(readRecentSearches());
            if (hasBridge()) {
              // Only an Iwara video ID comes back, never the clipboard text itself.
              void invoke("system:clipboard-video").then(setClipboardId).catch(() => setClipboardId(undefined));
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Delete" && empty && selected?.kind === "recent") {
              event.preventDefault();
              removeRecentSearch(selected.value);
              setRecent(readRecentSearches());
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              if (options.length > (empty ? 0 : 1)) {
                event.preventDefault();
                setActiveIndex((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
              }
            } else if (event.key === "Escape") {
              event.stopPropagation();
              if (value) {
                setValue("");
              } else {
                event.currentTarget.blur();
              }
            }
          }}
          placeholder={t("omnibox.placeholder")}
          ref={ref}
          role="combobox"
          spellCheck={false}
          value={value}
        />
        {value ? (
          <>
            {!showList && selected && (
              <span aria-hidden="true" className="omnibox__hint">
                {selected.kind === "video" ? t("omnibox.hintOpen") : t("omnibox.hintSearch")} <kbd>↵</kbd>
              </span>
            )}
            <button
              aria-label={t("omnibox.clear")}
              className="button button--ghost button--icon omnibox__clear"
              onClick={() => setValue("")}
              onMouseDown={(event) => event.preventDefault()}
              type="button"
            >
              <X aria-hidden="true" size={15} />
            </button>
          </>
        ) : (
          <span aria-hidden="true" className="omnibox__hint">
            <kbd>/</kbd>
          </span>
        )}
      </form>
      {showList && (
        <ul aria-label={empty && recent.length ? t("omnibox.recent") : undefined} className="omnibox__list" id={listId} role="listbox">
          {options.map((option, index) => {
            const Icon = ICONS[option.kind];
            return (
              <li
                aria-selected={index === activeIndex}
                className={option.kind === "clear-recent" ? "omnibox__option omnibox__option--muted" : "omnibox__option"}
                id={`${listId}-${index}`}
                key={`${option.kind}-${option.value}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  run(option);
                }}
                onMouseEnter={() => setActiveIndex(index)}
                role="option"
              >
                <Icon aria-hidden="true" size={16} />
                <span className="omnibox__option-label">{option.label}</span>
                {option.kind === "recent" && (
                  <button
                    aria-label={t("omnibox.removeRecent", { query: option.value })}
                    className="omnibox__remove"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      removeRecentSearch(option.value);
                      setRecent(readRecentSearches());
                    }}
                    tabIndex={-1}
                    type="button"
                  >
                    <X aria-hidden="true" size={14} />
                  </button>
                )}
                {index === activeIndex && option.kind !== "recent" && <kbd>↵</kbd>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});
