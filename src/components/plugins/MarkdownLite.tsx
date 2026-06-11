import { Fragment, ReactNode } from 'react';
import { parseInlineMarkdown } from '../../services/markdownService';

/**
 * Small block-level markdown renderer for marketplace README content.
 * Built from React nodes only (never raw HTML injection). Handles headings,
 * paragraphs, bullet and numbered lists, fenced code blocks, blockquotes,
 * images, and horizontal rules; inline formatting goes through the shared
 * parseInlineMarkdown. Raw HTML in the source is shown as text, which is the
 * safe and intended behavior for untrusted READMEs.
 */
const MarkdownLite = ({ content }: { content: string }) => {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let key = 0;

  let codeBuffer: string[] | null = null;
  let listBuffer: { ordered: boolean; items: string[] } | null = null;

  const flushList = () => {
    if (!listBuffer) return;
    const items = listBuffer.items.map((item, i) => (
      <li key={i} className="leading-relaxed">
        {parseInlineMarkdown(item)}
      </li>
    ));
    blocks.push(
      listBuffer.ordered ? (
        <ol key={`list-${key++}`} className="list-decimal space-y-1 pl-5">
          {items}
        </ol>
      ) : (
        <ul key={`list-${key++}`} className="list-disc space-y-1 pl-5">
          {items}
        </ul>
      )
    );
    listBuffer = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // Fenced code blocks swallow everything until the closing fence.
    if (codeBuffer !== null) {
      if (line.trim().startsWith('```')) {
        blocks.push(
          <pre
            key={`code-${key++}`}
            className="overflow-x-auto rounded-lg bg-black/30 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-textSecondary"
          >
            {codeBuffer.join('\n')}
          </pre>
        );
        codeBuffer = null;
      } else {
        codeBuffer.push(rawLine);
      }
      continue;
    }
    if (line.trim().startsWith('```')) {
      flushList();
      codeBuffer = [];
      continue;
    }

    const trimmed = line.trim();

    // Blank line ends any open list.
    if (!trimmed) {
      flushList();
      continue;
    }

    // Standalone image.
    const imageMatch = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(trimmed);
    if (imageMatch) {
      flushList();
      if (imageMatch[2].startsWith('https://')) {
        blocks.push(
          <img
            key={`img-${key++}`}
            src={imageMatch[2]}
            alt={imageMatch[1]}
            loading="lazy"
            className="max-h-72 rounded-lg"
          />
        );
      }
      continue;
    }

    // Horizontal rule: render as the short inset hairline, not full width.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushList();
      blocks.push(<div key={`hr-${key++}`} className="mx-8 my-1 h-px bg-white/[0.06]" />);
      continue;
    }

    // Headings.
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (headingMatch) {
      flushList();
      const depth = headingMatch[1].length;
      const text = parseInlineMarkdown(headingMatch[2]);
      blocks.push(
        depth === 1 ? (
          <h3 key={`h-${key++}`} className="pt-2 text-[15px] font-bold text-textPrimary">
            {text}
          </h3>
        ) : depth === 2 ? (
          <h4 key={`h-${key++}`} className="pt-2 text-[13.5px] font-semibold text-textPrimary">
            {text}
          </h4>
        ) : (
          <h5
            key={`h-${key++}`}
            className="pt-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-textMuted"
          >
            {text}
          </h5>
        )
      );
      continue;
    }

    // Blockquote.
    if (trimmed.startsWith('>')) {
      flushList();
      blocks.push(
        <div
          key={`quote-${key++}`}
          className="border-l-2 border-white/15 pl-3 text-[12.5px] italic leading-relaxed text-textSecondary"
        >
          {parseInlineMarkdown(trimmed.replace(/^>\s?/, ''))}
        </div>
      );
      continue;
    }

    // List items.
    const bulletMatch = /^[-*+]\s+(.*)$/.exec(trimmed);
    const orderedMatch = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (bulletMatch || orderedMatch) {
      const ordered = Boolean(orderedMatch);
      const item = (bulletMatch ?? orderedMatch)![1];
      if (listBuffer && listBuffer.ordered === ordered) {
        listBuffer.items.push(item);
      } else {
        flushList();
        listBuffer = { ordered, items: [item] };
      }
      continue;
    }

    // Plain paragraph line.
    flushList();
    blocks.push(
      <p key={`p-${key++}`} className="leading-relaxed">
        {parseInlineMarkdown(trimmed)}
      </p>
    );
  }
  flushList();
  if (codeBuffer !== null) {
    blocks.push(
      <pre
        key={`code-${key++}`}
        className="overflow-x-auto rounded-lg bg-black/30 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-textSecondary"
      >
        {(codeBuffer as string[]).join('\n')}
      </pre>
    );
  }

  return (
    <div className="space-y-2.5 text-[12.5px] text-textSecondary">
      {blocks.map((block, i) => (
        <Fragment key={i}>{block}</Fragment>
      ))}
    </div>
  );
};

export default MarkdownLite;
