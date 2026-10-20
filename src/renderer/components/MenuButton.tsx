import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export interface MenuItem {
  label: string;
  Icon?: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Renders as a checkable item. */
  checked?: boolean;
}

export type MenuEntry = MenuItem | "separator";

/**
 * Accessible menu button: Enter/Space/ArrowDown open, arrows move, Esc closes
 * and returns focus to the trigger, clicking outside closes.
 */
export function MenuButton({
  label,
  items,
  children,
  className = "button button--icon",
  align = "end",
  placement = "below"
}: {
  label: string;
  items: MenuEntry[];
  children: ReactNode;
  className?: string;
  align?: "start" | "end";
  placement?: "below" | "above";
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
    menuRef.current?.querySelector<HTMLElement>("[role^=menuitem]:not(:disabled)")?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) {
      triggerRef.current?.focus();
    }
  };

  return (
    <div className="menu-anchor" ref={anchorRef}>
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        className={className}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        ref={triggerRef}
        title={label}
        type="button"
      >
        {children}
      </button>
      {open && (
        <div
          aria-label={label}
          className={`menu menu--${align} menu--${placement}`}
          id={menuId}
          onKeyDown={(event) => {
            const entries = [...(menuRef.current?.querySelectorAll<HTMLElement>("[role^=menuitem]:not(:disabled)") ?? [])];
            const index = entries.indexOf(document.activeElement as HTMLElement);
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close(true);
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              entries[(index + step + entries.length) % entries.length]?.focus();
            } else if (event.key === "Home" || event.key === "End") {
              event.preventDefault();
              (event.key === "Home" ? entries[0] : entries.at(-1))?.focus();
            } else if (event.key === "Tab") {
              close(false);
            }
          }}
          ref={menuRef}
          role="menu"
        >
          {items.map((item, index) =>
            item === "separator" ? (
              <div className="menu__separator" key={`separator-${index}`} role="separator" />
            ) : (
              <button
                aria-checked={item.checked}
                className={item.danger ? "menu__item menu__item--danger" : "menu__item"}
                disabled={item.disabled}
                key={item.label}
                onClick={() => {
                  close(true);
                  item.onSelect();
                }}
                role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                tabIndex={-1}
                type="button"
              >
                {item.Icon && <item.Icon aria-hidden="true" size={16} />}
                {item.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
