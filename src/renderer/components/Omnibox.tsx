import { Film, Search, X } from "lucide-react";
import { forwardRef, useId, useMemo, useState } from "react";
import { classifyOmniboxInput } from "../../shared/video-id";
import { useI18n } from "../i18n";
import { useNavigationActions } from "../state/navigation";

interface Option {
  kind: "video" | "search";
  label: string;
  value: string;
}

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
  const listId = useId();

  const options = useMemo<Option[]>(() => {
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
  }, [value, t]);

  const showList = focused && options.length > 1;
  const selected = options[Math.min(activeIndex, options.length - 1)];

  const run = (option: Option | undefined) => {
    if (!option) {
      return;
    }
    if (option.kind === "video") {
      navigation.openVideo(option.value);
      setValue("");
    } else {
      navigation.searchFor(option.value);
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
          onFocus={() => setFocused(true)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              if (options.length > 1) {
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
        <ul className="omnibox__list" id={listId} role="listbox">
          {options.map((option, index) => (
            <li
              aria-selected={index === activeIndex}
              className="omnibox__option"
              id={`${listId}-${index}`}
              key={option.kind}
              onMouseDown={(event) => {
                event.preventDefault();
                run(option);
              }}
              onMouseEnter={() => setActiveIndex(index)}
              role="option"
            >
              {option.kind === "video" ? <Film aria-hidden="true" size={16} /> : <Search aria-hidden="true" size={16} />}
              <span className="omnibox__option-label">{option.label}</span>
              {index === activeIndex && <kbd>↵</kbd>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
