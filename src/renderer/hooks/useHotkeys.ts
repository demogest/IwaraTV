import { useEffect, useRef } from "react";

export interface Hotkeys {
  focusSearch(): void;
  back(): void;
  openSettings(): void;
  /** Ctrl/⌘+1…6 → the sidebar sections in order. */
  goToSection(index: number): void;
  showShortcuts(): void;
}

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)));
}

/**
 * Global shortcuts: `/` or Ctrl/⌘+K focuses search, Ctrl/⌘+, opens settings,
 * Ctrl/⌘+1…6 switch sections, `?` lists shortcuts, Esc / Alt+← / the mouse
 * back button go back.
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
      if (mod && !event.shiftKey && !event.altKey && /^[1-7]$/.test(event.key)) {
        event.preventDefault();
        ref.current.goToSection(Number(event.key) - 1);
        return;
      }
      if (event.key === "?" && !mod && !isTyping(event.target) && !document.querySelector("dialog[open]")) {
        event.preventDefault();
        ref.current.showShortcuts();
        return;
      }
      const blocked = Boolean(document.querySelector("dialog[open]") || document.fullscreenElement);
      if ((event.altKey && event.key === "ArrowLeft" && !isTyping(event.target)) || (event.key === "Escape" && !isTyping(event.target) && !blocked)) {
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
