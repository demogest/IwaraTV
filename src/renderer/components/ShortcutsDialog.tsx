import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n, type TranslationKey } from "../i18n";
import { modKey } from "../lib/format";

const OPEN_EVENT = "iwaratv:shortcuts";

/** Opens the keyboard shortcut list from anywhere (Settings, the top bar, `?`). */
export function openShortcuts(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

interface Shortcut {
  keys: string[];
  label: TranslationKey;
}

function groups(mod: string): Array<{ title: TranslationKey; items: Shortcut[] }> {
  return [
    {
      title: "shortcuts.general",
      items: [
        { keys: ["/", `${mod}+K`], label: "shortcuts.search" },
        { keys: [`${mod}+1…7`], label: "shortcuts.sections" },
        { keys: [`${mod}+,`], label: "shortcuts.settings" },
        { keys: ["Esc", "Alt+←"], label: "shortcuts.back" },
        { keys: [`${mod}+Enter`], label: "shortcuts.send" },
        { keys: ["?"], label: "shortcuts.help" }
      ]
    },
    {
      title: "shortcuts.player",
      items: [
        { keys: ["Space", "K"], label: "shortcuts.playPause" },
        { keys: ["←", "→"], label: "shortcuts.seek" },
        { keys: ["F"], label: "shortcuts.fullscreen" },
        { keys: ["M"], label: "shortcuts.mute" }
      ]
    }
  ];
}

export function ShortcutsDialog() {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog?.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      aria-labelledby="shortcuts-title"
      className="dialog dialog--wide"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          setOpen(false);
        }
      }}
      onClose={() => setOpen(false)}
      ref={dialogRef}
    >
      {open && (
        <div className="dialog__panel shortcuts">
          <div className="shortcuts__head">
            <h2 className="dialog__title" id="shortcuts-title">{t("shortcuts.title")}</h2>
            <button aria-label={t("common.close")} autoFocus className="button button--ghost button--icon" onClick={() => setOpen(false)} type="button">
              <X aria-hidden="true" size={18} />
            </button>
          </div>
          {groups(modKey()).map((group) => (
            <section className="shortcuts__group" key={group.title}>
              <h3 className="shortcuts__title">{t(group.title)}</h3>
              <dl className="shortcuts__list">
                {group.items.map((item) => (
                  <div className="shortcuts__row" key={item.label}>
                    <dt>{t(item.label)}</dt>
                    <dd>
                      {item.keys.map((key) => (
                        <kbd key={key}>{key}</kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      )}
    </dialog>
  );
}
