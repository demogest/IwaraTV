import { LoaderCircle, type LucideIcon } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useScrollMemory } from "../hooks/useScrollMemory";

// --- Avatar -------------------------------------------------------------------

const AVATAR_COLORS = ["#5b7cfa", "#c2558f", "#2f9d8f", "#c47f2c", "#7a5af5", "#3b8ed0", "#bf5b47", "#4f9a4f"];

function colorFor(seed: string): string {
  let hash = 0;
  for (const character of seed) {
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!;
}

export function Avatar({ name, url, size = 32 }: { name?: string; url?: string; size?: number }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const label = name?.trim() || "?";
  const initial = [...label][0]?.toUpperCase() ?? "?";
  const showImage = url && failedUrl !== url;
  return (
    <span
      aria-hidden="true"
      className="avatar"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), ["--avatar-bg" as string]: colorFor(label) }}
    >
      {showImage ? (
        <img alt="" decoding="async" loading="lazy" onError={() => setFailedUrl(url)} referrerPolicy="no-referrer" src={url} />
      ) : (
        initial
      )}
    </span>
  );
}

// --- Spinner ------------------------------------------------------------------

export function Spinner({ size = 16 }: { size?: number }) {
  return <LoaderCircle aria-hidden="true" className="spin" size={size} />;
}

// --- Empty / error states -------------------------------------------------------

export function StateMessage({
  Icon,
  title,
  body,
  tone = "default",
  children
}: {
  Icon: LucideIcon;
  title: string;
  body?: string;
  tone?: "default" | "error";
  children?: ReactNode;
}) {
  return (
    <div className={tone === "error" ? "state state--error" : "state"} role={tone === "error" ? "alert" : undefined}>
      <div className="state__icon">
        <Icon aria-hidden="true" size={26} />
      </div>
      <h2 className="state__title">{title}</h2>
      {body && <p className="state__body">{body}</p>}
      {children && <div className="state__actions">{children}</div>}
    </div>
  );
}

// --- Roving keyboard focus for radio groups and tab lists ------------------------

function moveFocus(event: KeyboardEvent<HTMLElement>, selector: string): HTMLElement | undefined {
  const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(selector)].filter((item) => !(item as HTMLButtonElement).disabled);
  const index = items.indexOf(document.activeElement as HTMLElement);
  let next: HTMLElement | undefined;
  if (event.key in keys && index >= 0) {
    next = items[(index + keys[event.key]! + items.length) % items.length];
  } else if (event.key === "Home") {
    next = items[0];
  } else if (event.key === "End") {
    next = items.at(-1);
  }
  if (next) {
    event.preventDefault();
    next.focus();
  }
  return next;
}

// --- Segmented control (radiogroup) ----------------------------------------------

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: string;
  Icon?: LucideIcon;
  disabled?: boolean;
}

export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  accent = false
}: {
  label: string;
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  accent?: boolean;
}) {
  return (
    <div
      aria-label={label}
      className={accent ? "segmented segmented--accent" : "segmented"}
      onKeyDown={(event) => {
        const next = moveFocus(event, "[role=radio]");
        const nextValue = next?.dataset.value;
        const option = options.find((item) => String(item.value) === nextValue);
        if (option) {
          onChange(option.value);
        }
      }}
      role="radiogroup"
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            aria-checked={checked}
            className="segmented__option"
            data-value={String(option.value)}
            disabled={option.disabled}
            key={String(option.value)}
            onClick={() => onChange(option.value)}
            role="radio"
            tabIndex={checked ? 0 : -1}
            type="button"
          >
            {option.Icon && <option.Icon aria-hidden="true" size={15} />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// --- Tabs -------------------------------------------------------------------------

export interface TabOption<T extends string> {
  value: T;
  label: string;
  Icon?: LucideIcon;
  count?: number;
}

export function Tabs<T extends string>({
  label,
  options,
  value,
  onChange,
  idPrefix
}: {
  label: string;
  options: Array<TabOption<T>>;
  value: T;
  onChange: (value: T) => void;
  idPrefix: string;
}) {
  return (
    <div
      aria-label={label}
      className="tabs"
      onKeyDown={(event) => {
        const next = moveFocus(event, "[role=tab]");
        const option = options.find((item) => item.value === next?.dataset.value);
        if (option) {
          onChange(option.value);
        }
      }}
      role="tablist"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            aria-controls={`${idPrefix}-panel`}
            aria-selected={selected}
            className="tabs__tab"
            data-value={option.value}
            id={`${idPrefix}-tab-${option.value}`}
            key={option.value}
            onClick={() => onChange(option.value)}
            role="tab"
            tabIndex={selected ? 0 : -1}
            type="button"
          >
            {option.Icon && <option.Icon aria-hidden="true" size={16} />}
            {option.label}
            {option.count !== undefined && <span className="tabs__count">{option.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

// --- Switch -------------------------------------------------------------------------

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    />
  );
}

// --- Page header -------------------------------------------------------------------

export function PageHeader({ title, subtitle, children }: { title: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-header__copy">
        <h1 className="page-header__title">{title}</h1>
        {subtitle && <p className="page-header__subtitle">{subtitle}</p>}
      </div>
      {children && <div className="page-header__actions">{children}</div>}
    </header>
  );
}

// --- View container -----------------------------------------------------------------

/** A scrollable page that stays mounted while hidden and remembers its scroll position. */
export function View({ active, label, children, refreshing }: { active: boolean; label: string; children: ReactNode; refreshing?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useScrollMemory(ref, active);
  return (
    <section aria-label={label} className="view" hidden={!active} ref={ref}>
      {refreshing && <div aria-hidden="true" className="refresh-indicator" />}
      <div className="view__inner">{children}</div>
    </section>
  );
}
