import { X } from "lucide-react";
import { useRef, useState } from "react";

/**
 * Token input for tags and hosts. Enter, comma or Tab commit the typed value;
 * pasted lists are split; Backspace on an empty field removes the last chip.
 */
export function ChipInput({
  label,
  values,
  onChange,
  placeholder,
  split,
  validate,
  tone = "default",
  removeLabel
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  /** Turns raw text into normalized values. */
  split: (text: string) => string[];
  validate?: (value: string) => boolean;
  tone?: "default" | "accent" | "danger";
  removeLabel: (value: string) => string;
}) {
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (text: string) => {
    const parsed = split(text);
    const valid = validate ? parsed.filter(validate) : parsed;
    setInvalid(parsed.length > 0 && valid.length < parsed.length);
    const next = [...values, ...valid.filter((value) => !values.includes(value))];
    if (next.length !== values.length) {
      onChange(next);
    }
    if (valid.length === parsed.length) {
      setDraft("");
    }
  };

  const chipClass = tone === "accent" ? "chip chip--accent" : tone === "danger" ? "chip chip--danger" : "chip";

  return (
    <div className="chip-input" onClick={() => inputRef.current?.focus()}>
      {values.map((value) => (
        <span className={chipClass} key={value}>
          {value}
          <button
            aria-label={removeLabel(value)}
            className="chip__remove"
            onClick={(event) => {
              event.stopPropagation();
              onChange(values.filter((item) => item !== value));
            }}
            type="button"
          >
            <X aria-hidden="true" size={12} />
          </button>
        </span>
      ))}
      <input
        aria-invalid={invalid}
        aria-label={label}
        onBlur={() => draft.trim() && commit(draft)}
        onChange={(event) => {
          const text = event.target.value;
          setInvalid(false);
          if (/[,，;；\n]/.test(text)) {
            commit(text);
          } else {
            setDraft(text);
          }
        }}
        onKeyDown={(event) => {
          if ((event.key === "Enter" || event.key === "Tab") && draft.trim()) {
            if (event.key === "Enter") {
              event.preventDefault();
            }
            commit(draft);
          } else if (event.key === "Backspace" && !draft && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text");
          if (/[\s,，;；]/.test(text.trim())) {
            event.preventDefault();
            commit(`${draft} ${text}`);
          }
        }}
        placeholder={values.length ? "" : placeholder}
        ref={inputRef}
        value={draft}
      />
    </div>
  );
}
