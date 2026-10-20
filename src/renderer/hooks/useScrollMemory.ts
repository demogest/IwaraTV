import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Keeps a scroll container's position while it is hidden (views stay mounted
 * but `hidden` resets layout) and restores it when the view becomes active.
 */
export function useScrollMemory(ref: RefObject<HTMLElement | null>, active: boolean): void {
  const position = useRef(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const onScroll = () => {
      if (!element.hidden) {
        position.current = element.scrollTop;
      }
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [ref]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (active && element) {
      element.scrollTop = position.current;
      // Content may still be laying out; re-apply once on the next frame.
      const frame = requestAnimationFrame(() => {
        element.scrollTop = position.current;
      });
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [active, ref]);
}

export function scrollToTop(element: HTMLElement | null | undefined): void {
  element?.closest<HTMLElement>(".view")?.scrollTo({ top: 0 });
}
