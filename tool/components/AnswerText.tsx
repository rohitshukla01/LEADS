"use client";

// Renders an answer with light markdown structure and clickable [N] citation chips.
//
// Display-only: it renders the display copy of the answer that app/page.tsx builds
// (citationView: citations renumbered, text tidied) and never modifies it.
//
// Hand-rolled rather than a markdown library: an answer holds only a few constructs (the
// deterministic `>` operational-check banner and, in some answers, `**bold**` labels and
// `- ` bullets), and a custom renderer keeps the citation chips working inside formatted
// text. Anything it does not recognise is passed through verbatim.
//
// Fail-soft: unknown syntax renders as plain text; a parse error falls back to the
// unformatted text; while an answer is streaming it renders plain (a half-received `**`
// would otherwise flicker).
//
// Flag: NEXT_PUBLIC_LEADS_MARKDOWN_ENABLED="false" renders the raw text.

import type { ReactNode } from "react";

const ENABLED = process.env.NEXT_PUBLIC_LEADS_MARKDOWN_ENABLED !== "false";

const CY = "#02436e"; // LEADS brand navy-teal (matches the app palette's C.am)

// `scopeNote`: the deterministic check's scope line ("Check used ... only. Not
// evaluated: ..."), printed as a fixed footnote under the answer. It comes from the
// constraint evaluation, not the prose, so it is shown even when the model leaves it
// out; it never touches `text`.
type Props = { text: string; streaming?: boolean; onCitationClick: (n: number) => void; scopeNote?: string | null };

function ScopeLine({ note }: { note: string }) {
  return (
    <div style={{
      marginTop: 12, paddingTop: 9, borderTop: "1px dashed #d8d3c6",
      fontSize: 13.5, lineHeight: 1.55, fontWeight: 500, color: "#54544e",
    }}>
      {note}
    </div>
  );
}

// Inline: **bold** and [N] chips
// One tokenizer for both so a chip inside bold still renders as a chip.
//
// The bracket alternative also accepts the comma-grouped form the synthesis model
// sometimes emits ("[4, 6, 7, 15]" instead of "[4][6][7][15]"). Each number in a group
// becomes its own chip, so both forms render the same. This normalises the visible
// text (the commas are dropped); it is the one place this renderer does not reproduce
// the source verbatim.
const INLINE = /(\*\*[^*]+\*\*|\[\d+(?:\s*,\s*\d+)*\])/g;
const BRACKET_GROUP = /^\[(\d+(?:\s*,\s*\d+)*)\]$/;

function citationChip(n: number, key: string, onCitationClick: (n: number) => void) {
  return (
    <span
      key={key}
      onClick={() => onCitationClick(n)}
      title={`Jump to source ${n}`}
      style={{
        color: CY, cursor: "pointer", fontWeight: 600,
        background: "rgba(2,67,110,0.07)", borderRadius: 4, padding: "0 5px",
        fontSize: "0.8em", verticalAlign: "1px", fontVariantNumeric: "tabular-nums",
        border: "none",
        transition: "background 0.15s", display: "inline-block", lineHeight: 1.5,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "rgba(2,67,110,0.15)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "rgba(2,67,110,0.07)";
      }}
    >{`[${n}]`}</span>
  );
}

function renderInline(text: string, keyBase: string, onCitationClick: (n: number) => void, depth = 0): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const key = `${keyBase}-${i}`;
    if (!part) return null;
    const cite = part.match(BRACKET_GROUP);
    if (cite) {
      const nums = cite[1].split(/\s*,\s*/).map((n) => parseInt(n, 10)).filter(Number.isFinite);
      return nums.map((n, j) => citationChip(n, `${key}-c${j}`, onCitationClick));
    }
    if (depth === 0 && /^\*\*[^*]+\*\*$/.test(part)) {
      // Body text is Geist 400, so 650 gives a clear but quiet step for bold labels.
      return <strong key={key} style={{ fontWeight: 650, letterSpacing: "0" }}>{renderInline(part.slice(2, -2), key, onCitationClick, 1)}</strong>;
    }
    return <span key={key}>{part}</span>;
  });
}

// Blocks
type Block =
  | { kind: "quote"; lines: string[] }
  | { kind: "list"; items: string[] }
  | { kind: "para"; lines: string[] };

const isQuote = (l: string) => /^\s*>/.test(l);
const isBullet = (l: string) => /^\s*[-*]\s+/.test(l);

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === "") { i++; continue; }
    if (isQuote(lines[i])) {
      const buf: string[] = [];
      while (i < lines.length && isQuote(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push({ kind: "quote", lines: buf });
    } else if (isBullet(lines[i])) {
      const buf: string[] = [];
      while (i < lines.length && isBullet(lines[i])) buf.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
      out.push({ kind: "list", items: buf });
    } else {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim() !== "" && !isQuote(lines[i]) && !isBullet(lines[i])) buf.push(lines[i++]);
      // A leading all-bold line is a section label ("Confidence:") that the model
      // writes directly above its prose with no blank line. Split it into its own
      // block so it gets the same heading treatment as a label followed by a list.
      if (buf.length > 1 && /^\*\*[^*]+\*\*$/.test(buf[0].trim())) {
        out.push({ kind: "para", lines: [buf[0]] });
        out.push({ kind: "para", lines: buf.slice(1) });
      } else {
        out.push({ kind: "para", lines: buf });
      }
    }
  }
  return out;
}

/** Lines joined with <br/> - line structure is preserved exactly as the model wrote it,
 *  so nothing is silently merged. */
function lines(ls: string[], keyBase: string, onCitationClick: (n: number) => void): ReactNode[] {
  return ls.map((l, i) => (
    <span key={`${keyBase}-l${i}`}>
      {i > 0 && <br />}
      {renderInline(l, `${keyBase}-l${i}`, onCitationClick)}
    </span>
  ));
}

function PlainText({ text, onCitationClick }: { text: string; onCitationClick: (n: number) => void }) {
  return <span style={{ whiteSpace: "pre-wrap" }}>{renderInline(text, "plain", onCitationClick)}</span>;
}

export default function AnswerText({ text, streaming, onCitationClick, scopeNote }: Props) {
  const scope = !streaming && scopeNote ? <ScopeLine note={scopeNote} /> : null;
  // Raw while streaming (partial markdown would flicker) and when the flag is off.
  if (!ENABLED || streaming) return <><PlainText text={text} onCitationClick={onCitationClick} />{scope}</>;
  try {
    const blocks = parseBlocks(text);
    if (!blocks.length) return <><PlainText text={text} onCitationClick={onCitationClick} />{scope}</>;
    return (
      <div>
        {blocks.map((b, i) => {
          if (b.kind === "quote") {
            // The operational check - the verdict a manager reads first, so it gets a
            // callout instead of a line beginning with a stray ">".
            return (
              <div key={i} style={{
                // A soft sand tint: clearly set apart from the white answer, the ivory page and
                // the blue question card, and neutral (the verdict can be "below threshold").
                background: "#f8f1e3", border: "1px solid #e8d9bc", borderRadius: 10,
                padding: "13px 16px", margin: i === 0 ? "0 0 16px" : "16px 0",
              }}>
                {lines(b.lines, `q${i}`, onCitationClick)}
              </div>
            );
          }
          if (b.kind === "list") {
            return (
              <ul key={i} style={{ margin: "0 0 12px", paddingLeft: 22 }}>
                {b.items.map((it, j) => (
                  <li key={j} style={{ marginBottom: 6 }}>{renderInline(it, `u${i}-${j}`, onCitationClick)}</li>
                ))}
              </ul>
            );
          }
          // A paragraph that is only a bold label ("Supporting evidence:",
          // "Confidence:") is a section heading, not prose: it gets more space above
          // and sits close to the block it introduces.
          const isHeading = b.lines.length === 1 && /^\*\*[^*]+\*\*$/.test(b.lines[0].trim());
          return (
            <p key={i} style={{ margin: isHeading ? (i === 0 ? "0 0 7px" : "18px 0 7px") : "0 0 12px" }}>
              {lines(b.lines, `p${i}`, onCitationClick)}
            </p>
          );
        })}
        {scope}
      </div>
    );
  } catch {
    return <><PlainText text={text} onCitationClick={onCitationClick} />{scope}</>;
  }
}
