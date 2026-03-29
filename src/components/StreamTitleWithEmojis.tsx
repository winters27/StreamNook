import { useEffect, useState } from 'react';
import { parseEmojisProxied, EmojiSegment } from '../services/emojiService';

/**
 * Renders a stream title with Apple-style emoji images inline.
 * Shared between Home stream cards and VideoPlayer overlay.
 */
const StreamTitleWithEmojis = ({ title }: { title: string }) => {
    const [segments, setSegments] = useState<EmojiSegment[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        let mounted = true;

        parseEmojisProxied(title)
            .then((result) => {
                if (mounted) {
                    setSegments(result);
                    setIsLoading(false);
                }
            })
            .catch(() => {
                if (mounted) {
                    setSegments([{ type: 'text', content: title }]);
                    setIsLoading(false);
                }
            });

        return () => {
            mounted = false;
        };
    }, [title]);

    if (isLoading) {
        return <>{title}</>;
    }

    return (
        <>
            {segments.map((segment, idx) =>
                segment.type === 'emoji' && segment.emojiUrl && segment.emojiUrl.startsWith('data:') ? (
                    <img
                        key={idx}
                        src={segment.emojiUrl}
                        alt={segment.content}
                        className="inline-block w-4 h-4 object-contain align-text-bottom mx-px"
                        style={{ verticalAlign: '-3px' }}
                        loading="lazy"
                    />
                ) : (
                    <span key={idx}>{segment.content}</span>
                )
            )}
        </>
    );
};

export default StreamTitleWithEmojis;
