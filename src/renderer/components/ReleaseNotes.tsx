import type { ReactNode } from "react";

type Block =
  | { kind: "heading"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "paragraph"; text: string };

/**
 * Release notes are Markdown written by the maintainers. Only headings, lists,
 * paragraphs, **bold** and `code` are rendered; links show as their text, and
 * everything goes through React text nodes (no HTML).
 */
export function parseNotes(markdown: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: string[] | undefined;
  const flush = () => {
    if (paragraph.length) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
    if (list) {
      blocks.push({ kind: "list", items: list });
      list = undefined;
    }
  };

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.replace(/^>\s?/, "").trimEnd();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flush();
    } else if (heading) {
      flush();
      blocks.push({ kind: "heading", text: heading[1]! });
    } else if (item) {
      if (paragraph.length) {
        flush();
      }
      list ??= [];
      list.push(item[1]!);
    } else if (list && /^\s+/.test(raw)) {
      // A wrapped list item.
      list[list.length - 1] += ` ${line.trim()}`;
    } else {
      if (list) {
        flush();
      }
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks;
}

function inline(text: string): ReactNode[] {
  const plain = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  return plain.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

/** `hideTitle` drops a leading "IwaraTV x.y" heading that would repeat the surrounding title. */
export function ReleaseNotes({ markdown, hideTitle }: { markdown: string; hideTitle?: boolean }) {
  const blocks = parseNotes(markdown);
  if (hideTitle && blocks[0]?.kind === "heading" && /^IwaraTV\b/i.test(blocks[0].text)) {
    blocks.shift();
  }
  return (
    <div className="release-notes">
      {blocks.map((block, index) => {
        if (block.kind === "heading") {
          return <h4 key={index}>{inline(block.text)}</h4>;
        }
        if (block.kind === "list") {
          return (
            <ul key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{inline(item)}</li>
              ))}
            </ul>
          );
        }
        return <p key={index}>{inline(block.text)}</p>;
      })}
    </div>
  );
}
