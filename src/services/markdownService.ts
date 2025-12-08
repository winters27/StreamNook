import React from 'react';

/**
 * Parse inline markdown formatting and return React elements
 * Handles: **bold**, *italic*, `code`, and [links](url)
 */
export const parseInlineMarkdown = (text: string): React.ReactNode[] => {
    const elements: React.ReactNode[] = [];
    let currentIndex = 0;
    let keyIndex = 0;

    // Combined regex for all inline markdown patterns
    // Order matters: **bold** before *italic* to handle ** correctly
    const patterns = [
        { regex: /\*\*(.+?)\*\*/g, type: 'bold' },
        { regex: /\*(.+?)\*/g, type: 'italic' },
        { regex: /`(.+?)`/g, type: 'code' },
        { regex: /\[(.+?)\]\((.+?)\)/g, type: 'link' },
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
