import React from 'react';

/**
 * Color palette for `<@username>` mention pills. Each entry is a Tailwind
 * class trio (bg / border / text) so the JIT picks them up via static string
 * scanning — do NOT build these class names dynamically.
 *
 * Discord assigns role colors per user; we do the same idea by hashing the
 * username so the same person always gets the same color across changelog
 * entries while different reporters visually distinguish.
 */
const MENTION_PALETTE = [
    { bg: 'bg-violet-500/20', border: 'border-violet-400/50', text: 'text-violet-200' },
    { bg: 'bg-pink-500/20',   border: 'border-pink-400/50',   text: 'text-pink-200' },
    { bg: 'bg-cyan-500/20',   border: 'border-cyan-400/50',   text: 'text-cyan-200' },
    { bg: 'bg-emerald-500/20',border: 'border-emerald-400/50',text: 'text-emerald-200' },
    { bg: 'bg-amber-500/20',  border: 'border-amber-400/50',  text: 'text-amber-200' },
    { bg: 'bg-rose-500/20',   border: 'border-rose-400/50',   text: 'text-rose-200' },
    { bg: 'bg-sky-500/20',    border: 'border-sky-400/50',    text: 'text-sky-200' },
    { bg: 'bg-fuchsia-500/20',border: 'border-fuchsia-400/50',text: 'text-fuchsia-200' },
];

const pickMentionPalette = (username: string) => {
    // djb2-ish hash so same username -> same color across reloads.
    let h = 5381;
    for (let i = 0; i < username.length; i++) {
        h = ((h << 5) + h + username.charCodeAt(i)) >>> 0;
    }
    return MENTION_PALETTE[h % MENTION_PALETTE.length];
};

/**
 * Parse inline markdown formatting and return React elements
 * Handles: **bold**, *italic*, `code`, [links](url), and <@username> mentions
 */
export const parseInlineMarkdown = (text: string): React.ReactNode[] => {
    const elements: React.ReactNode[] = [];
    let currentIndex = 0;
    let keyIndex = 0;

    // Combined regex for all inline markdown patterns.
    // Order matters:
    //   - `code` first so text inside backticks is consumed before anything
    //     else (otherwise `<@user>` inside backticks renders BOTH as a code
    //     pill AND a mention pill — the overlap check only catches
    //     "starts-inside" cases).
    //   - `link` next so `[text](url)` wins over any sub-tokens.
    //   - `**bold**` before `*italic*` so `**` isn't eaten by italic.
    //   - `mention` last so it only renders when not nested inside other
    //     formatting (e.g. inside `**<@x>**` the bold wins, no double pill).
    const patterns = [
        { regex: /`(.+?)`/g, type: 'code' },
        { regex: /\[(.+?)\]\((.+?)\)/g, type: 'link' },
        { regex: /\*\*(.+?)\*\*/g, type: 'bold' },
        { regex: /\*(.+?)\*/g, type: 'italic' },
        { regex: /<@([\w][\w-]*)>/g, type: 'mention' },
    ];

    // Find all matches and their positions
    const matches: { index: number; length: number; type: string; content: string; url?: string }[] = [];

    for (const { regex, type } of patterns) {
        let match;
        const regexCopy = new RegExp(regex.source, 'g');
        while ((match = regexCopy.exec(text)) !== null) {
            // Check if this position is already covered by a previous match (e.g., ** vs *)
            const alreadyCovered = matches.some(
                (m) => match!.index >= m.index && match!.index < m.index + m.length
            );
            if (!alreadyCovered) {
                matches.push({
                    index: match.index,
                    length: match[0].length,
                    type,
                    content: type === 'link' ? match[1] : match[1],
                    url: type === 'link' ? match[2] : undefined,
                });
            }
        }
    }

    // Sort matches by position
    matches.sort((a, b) => a.index - b.index);

    // Build elements array
    for (const match of matches) {
        // Add plain text before this match
        if (match.index > currentIndex) {
            elements.push(text.substring(currentIndex, match.index));
        }

        // Add the formatted element
        switch (match.type) {
            case 'bold':
                elements.push(
                    React.createElement(
                        'strong',
                        { key: `bold-${keyIndex++}`, className: 'font-semibold text-textPrimary' },
                        match.content
                    )
                );
                break;
            case 'italic':
                elements.push(
                    React.createElement(
                        'em',
                        { key: `italic-${keyIndex++}`, className: 'italic' },
                        match.content
                    )
                );
                break;
            case 'code':
                elements.push(
                    React.createElement(
                        'code',
                        {
                            key: `code-${keyIndex++}`,
                            className: 'bg-white/10 px-1.5 py-0.5 rounded text-xs font-mono text-accent',
                        },
                        match.content
                    )
                );
                break;
            case 'link':
                elements.push(
                    React.createElement(
                        'a',
                        {
                            key: `link-${keyIndex++}`,
                            href: match.url,
                            target: '_blank',
                            rel: 'noopener noreferrer',
                            className: 'text-accent hover:underline',
                        },
                        match.content
                    )
                );
                break;
            case 'mention': {
                // Discord-style credit pill. Used in changelog entries to thank
                // community members who reported issues (syntax: `<@username>`).
                // Color is hashed from the username so each person stays
                // consistent across entries; different people get different
                // pills. See MENTION_PALETTE above.
                const palette = pickMentionPalette(match.content);
                elements.push(
                    React.createElement(
                        'span',
                        {
                            key: `mention-${keyIndex++}`,
                            className:
                                'inline-flex items-center px-2 py-0.5 rounded-full ' +
                                `${palette.bg} border ${palette.border} ${palette.text} ` +
                                'text-xs font-medium align-baseline',
                        },
                        `@${match.content}`
                    )
                );
                break;
            }
        }

        currentIndex = match.index + match.length;
    }

    // Add remaining plain text
    if (currentIndex < text.length) {
        elements.push(text.substring(currentIndex));
    }

    // If no matches found, return original text
    if (elements.length === 0) {
        return [text];
    }

    return elements;
};
