import type { ReactNode } from "react";

/**
 * Just enough Markdown for a page somebody typed into Directus.
 *
 * Not a library, and not `dangerouslySetInnerHTML`. The body of a page
 * is written by staff in an admin, which makes it *trusted-ish* rather
 * than trusted — and the difference matters on a public website where
 * the same field could one day be filled by an import, a migration or
 * whoever holds the practice-owner password. Building React elements
 * means there is no HTML string to sanitise, so there is no sanitiser to
 * get wrong.
 *
 * What it does: headings, paragraphs, bullet and numbered lists, links,
 * bold and italic. What it deliberately does not: images, tables, raw
 * HTML, scripts. A practice writing terms and a complaints procedure
 * needs the first list; the second is how a rich-text field becomes an
 * attack surface.
 */

type Block =
  | { kind: "h2"; text: string }
  | { kind: "h3"; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] };

function blocks(md: string): Block[] {
  const out: Block[] = [];
  let list: { kind: "ul" | "ol"; items: string[] } | null = null;

  const flush = () => {
    if (list) { out.push(list); list = null; }
  };

  for (const raw of md.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();

    if (!line.trim()) { flush(); continue; }

    const heading = /^(#{2,3})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      out.push({ kind: heading[1]!.length === 2 ? "h2" : "h3", text: heading[2]!.trim() });
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list || list.kind !== "ul") { flush(); list = { kind: "ul", items: [] }; }
      list.items.push(bullet[1]!.trim());
      continue;
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      if (!list || list.kind !== "ol") { flush(); list = { kind: "ol", items: [] }; }
      list.items.push(numbered[1]!.trim());
      continue;
    }

    // A paragraph continues across single newlines, the way Markdown
    // means it to: a line break in the editor is not a line break on the
    // page, or every sentence somebody wrapped becomes its own block.
    const last = out[out.length - 1];
    if (!list && last && last.kind === "p") {
      last.text = `${last.text} ${line.trim()}`;
    } else {
      flush();
      out.push({ kind: "p", text: line.trim() });
    }
  }
  flush();
  return out;
}

/** `**bold**`, `*italic*` and `[text](href)`, as elements. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let at = 0;
  let m: RegExpExecArray | null;
  let n = 0;

  while ((m = pattern.exec(text))) {
    if (m.index > at) out.push(text.slice(at, m.index));
    const key = `${keyPrefix}-${n++}`;
    if (m[1] && m[2]) {
      const href = m[2];
      // Only http(s), mailto and tel, and only a relative path that
      // cannot leave the site. `javascript:` in a link is the one thing
      // a rich-text field must never be able to produce.
      const safe = /^(https?:|mailto:|tel:|\/(?!\/))/i.test(href);
      out.push(safe ? <a key={key} href={href}>{m[1]}</a> : <span key={key}>{m[1]}</span>);
    } else if (m[3]) {
      out.push(<strong key={key}>{m[3]}</strong>);
    } else if (m[4]) {
      out.push(<em key={key}>{m[4]}</em>);
    }
    at = pattern.lastIndex;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

export function Markdown({ source }: { source: string | null | undefined }) {
  if (!source) return null;
  return (
    <>
      {blocks(source).map((b, i) => {
        const key = `b${i}`;
        if (b.kind === "h2") return <h2 key={key}>{inline(b.text, key)}</h2>;
        if (b.kind === "h3") return <h3 key={key}>{inline(b.text, key)}</h3>;
        if (b.kind === "p") return <p key={key}>{inline(b.text, key)}</p>;
        const items = b.items.map((it, j) => (
          <li key={`${key}-${j}`}>{inline(it, `${key}-${j}`)}</li>
        ));
        if (b.kind === "ul") return <ul key={key}>{items}</ul>;
        return <ol key={key}>{items}</ol>;
      })}
    </>
  );
}
