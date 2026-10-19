import { useEffect, useRef } from "react";

export interface Hotkeys {
  focusSearch(): void;
  back(): void;
  openSettings(): void;
}

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)));
}

/**
 * Global shortcuts: `/` or Ctrl/⌘+K focuses search, Ctrl/⌘+, opens settings,
 * Esc / Alt+← / the mouse back button go back.
 */
export function useHotkeys(handlers: Hotkeys): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if ((mod && event.key.toLowerCase() === "k") || (mod && event.key.toLowerCase() === "l") || (event.key === "/" && !isTyping(event.target))) {
        event.preventDefault();
        ref.current.focusSearch();
        return;
      }
      if (mod && event.key === ",") {
        event.preventDefault();
        ref.current.openSettings();
        return;
      }
      if ((event.altKey && event.key === "ArrowLeft") || (event.key === "Escape" && !isTyping(event.target) && !document.querySelector("dialog[open]"))) {
        ref.current.back();
      }
    };
    const onMouseUp = (event: MouseEvent) => {
      if (event.button === 3) {
        event.preventDefault();
        ref.current.back();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);
}
