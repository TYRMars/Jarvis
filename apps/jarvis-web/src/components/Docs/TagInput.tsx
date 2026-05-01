import { useRef, useState } from "react";
import { t } from "../../utils/i18n";

interface TagInputProps {
  tags: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** Suggestions shown inline when the input is focused (most-used in workspace). */
  suggestions?: string[];
}

export function TagInput({
  tags,
  onChange,
  placeholder,
  suggestions = [],
}: TagInputProps) {
  const resolvedPlaceholder = placeholder ?? t("docsTagPlaceholder");
  const [draft, setDraft] = useState("");
  const [composing, setComposing] = useState(false);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const commitDraft = () => {
    const v = draft.trim();
    if (!v) {
      setDraft("");
      return;
    }
    if (!tags.includes(v)) {
      onChange([...tags, v]);
    }
    setDraft("");
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter((entry) => entry !== tag));
  };

  const filteredSuggestions = suggestions
    .filter((s) => !tags.includes(s))
    .filter((s) => !draft || s.toLowerCase().includes(draft.toLowerCase()))
    .slice(0, 6);

  return (
    <div
      className={"docs-tag-input" + (focused ? " is-focused" : "")}
      onClick={() => inputRef.current?.focus()}
    >
      {tags.map((tag) => (
        <span key={tag} className="docs-tag-chip">
          <span className="docs-tag-chip-label">{tag}</span>
          <button
            type="button"
            className="docs-tag-chip-x"
            aria-label={t("docsTagRemoveAria", tag)}
            onClick={(e) => {
              e.stopPropagation();
              removeTag(tag);
            }}
          >
            ×
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        type="text"
        value={draft}
        placeholder={tags.length === 0 ? resolvedPlaceholder : ""}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commitDraft();
        }}
        // Use compositionstart/end so IME (e.g. Chinese pinyin) doesn't get
        // its space/comma swallowed by the splitter while still composing.
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDown={(e) => {
          if (composing) return;
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commitDraft();
          } else if (e.key === "Backspace" && !draft && tags.length > 0) {
            e.preventDefault();
            removeTag(tags[tags.length - 1]);
          }
        }}
      />
      {focused && filteredSuggestions.length > 0 ? (
        <ul className="docs-tag-suggestions" role="listbox">
          {filteredSuggestions.map((s) => (
            <li key={s}>
              <button
                type="button"
                className="docs-tag-suggestion"
                onMouseDown={(e) => {
                  // Prevent input blur before click fires.
                  e.preventDefault();
                  if (!tags.includes(s)) onChange([...tags, s]);
                  setDraft("");
                  inputRef.current?.focus();
                }}
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
