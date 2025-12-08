/**
 * Emoji Service - Converts Unicode emojis to iOS-style emoji images
 * Uses Tauri proxy to fetch CDN-hosted Apple emoji images (bypasses tracking prevention)
 */
import { SHORTCODE_TO_UNICODE } from './emojiMap';
import { invoke } from '@tauri-apps/api/core';

// Cache for proxied emoji URLs (codepoint -> data URL)
const proxiedEmojiCache = new Map<string, string>();

// Regular expression to match emoji characters
// This regex covers most common emojis including:
// - Basic emojis (😀-🙏)
// - Skin tone modifiers
// - ZWJ sequences (family, profession emojis)
// - Regional indicators (flags)
// - Keycap emojis
const EMOJI_REGEX = /(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(?:\p{Emoji_Modifier})?(?:\u200D(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(?:\p{Emoji_Modifier})?)*|\p{Regional_Indicator}{2}/gu;

// CDN URL for Apple emoji images
// Using jsDelivr CDN with emoji-datasource-apple package
const APPLE_EMOJI_CDN = 'https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.1.2/img/apple/64';

/**
 * Converts a single emoji character/sequence to its hex codepoint representation
 * Used to build the image URL
 */
export function emojiToCodepoint(emoji: string): string {
    const codepoints: string[] = [];

    for (const char of emoji) {
        const codepoint = char.codePointAt(0);
        if (codepoint !== undefined) {
            // Skip variation selector-16 (FE0F) as it's not always in filenames
            if (codepoint !== 0xFE0F) {
                codepoints.push(codepoint.toString(16).toLowerCase());
            }
        }
    }

    return codepoints.join('-');
}

/**
 * Gets the Apple emoji image URL for a given emoji
 */
export function getAppleEmojiUrl(emoji: string): string {
    const codepoint = emojiToCodepoint(emoji);
    return `${APPLE_EMOJI_CDN}/${codepoint}.png`;
}

/**
 * Checks if a string contains any emoji characters
 */
export function containsEmoji(text: string): boolean {
    return EMOJI_REGEX.test(text);
}

/**
 * Replaces emoji shortcodes in text with their unicode equivalents
 * Only matches shortcodes wrapped in colons like :smiley: or :heart:
 */
function replaceShortcodes(text: string): string {
    if (!text) return text;

    // Only match shortcodes that are wrapped in colons like :smiley:
    // This regex matches :word_with_underscores: or :word-with-dashes: or :word123:
    return text.replace(/:([a-zA-Z0-9_-]+):/g, (match, shortcode) => {
        // First try the full match with colons
        if (SHORTCODE_TO_UNICODE[match]) {
            return SHORTCODE_TO_UNICODE[match];
        }
        // Then try just the shortcode without colons
        if (SHORTCODE_TO_UNICODE[shortcode]) {
            return SHORTCODE_TO_UNICODE[shortcode];
        }
        // Return original if no match
        return match;
    });
}

/**
 * Parses text and returns segments with emojis separated
 * Returns an array of objects with type 'text' or 'emoji'
 */
export interface EmojiSegment {
    type: 'text' | 'emoji';
    content: string;
    emojiUrl?: string;
}

export function parseEmojis(text: string): EmojiSegment[] {
    if (!text) {
        return [];
    }

    // First replace any shortcodes with actual unicode emojis
    const processedText = replaceShortcodes(text);

    // Reset regex lastIndex
    EMOJI_REGEX.lastIndex = 0;

    const segments: EmojiSegment[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = EMOJI_REGEX.exec(processedText)) !== null) {
        // Add text before the emoji
        if (match.index > lastIndex) {
            segments.push({
                type: 'text',
                content: processedText.substring(lastIndex, match.index),
            });
        }

        // Add the emoji
        const emoji = match[0];
        segments.push({
            type: 'emoji',
            content: emoji,
            emojiUrl: getAppleEmojiUrl(emoji),
        });

        lastIndex = match.index + emoji.length;
    }

    // Add remaining text after the last emoji
    if (lastIndex < processedText.length) {
        segments.push({
            type: 'text',
            content: processedText.substring(lastIndex),
        });
    }

    return segments.length > 0 ? segments : [{ type: 'text', content: processedText }];
}

/**
 * Cache for emoji URL validity to avoid repeated 404s
 * Maps codepoint to boolean indicating if the URL is valid
 */
const emojiUrlCache = new Map<string, boolean>();

/**
 * Preloads and validates an emoji URL
 * Returns true if the image loads successfully
 */
export async function validateEmojiUrl(emoji: string): Promise<boolean> {
    const codepoint = emojiToCodepoint(emoji);

    if (emojiUrlCache.has(codepoint)) {
        return emojiUrlCache.get(codepoint)!;
    }

    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            emojiUrlCache.set(codepoint, true);
            resolve(true);
        };
        img.onerror = () => {
            emojiUrlCache.set(codepoint, false);
            resolve(false);
        };
        img.src = getAppleEmojiUrl(emoji);
    });
}

/**
 * Gets the Apple emoji image URL through Tauri's proxy
 * This bypasses browser tracking prevention by using Tauri's HTTP client
 * Returns a base64 data URL that can be used directly in img src
 */
export async function getProxiedEmojiUrl(emoji: string): Promise<string> {
    const codepoint = emojiToCodepoint(emoji);

    // Check frontend cache first
    if (proxiedEmojiCache.has(codepoint)) {
        return proxiedEmojiCache.get(codepoint)!;
    }

    try {
        // Fetch through Tauri proxy (cached in Rust backend)
        const dataUrl = await invoke<string>('get_emoji_image', { codepoint });

        // Cache in frontend
        proxiedEmojiCache.set(codepoint, dataUrl);

        return dataUrl;
    } catch (error) {
        console.warn(`Failed to fetch emoji via proxy: ${codepoint}`, error);
        // Return the native emoji as fallback
        return emoji;
    }
}

/**
 * Parses text and returns segments with emojis separated, using proxied URLs
 * This is an async version that fetches emoji images through Tauri's proxy
 */
export async function parseEmojisProxied(text: string): Promise<EmojiSegment[]> {
    if (!text) {
        return [];
    }

    // First replace any shortcodes with actual unicode emojis
    const processedText = replaceShortcodes(text);

    // Reset regex lastIndex
    EMOJI_REGEX.lastIndex = 0;

    const segments: EmojiSegment[] = [];
    const emojiPromises: Array<{ index: number; emoji: string; promise: Promise<string> }> = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let segmentIndex = 0;

    while ((match = EMOJI_REGEX.exec(processedText)) !== null) {
        // Add text before the emoji
        if (match.index > lastIndex) {
            segments.push({
                type: 'text',
                content: processedText.substring(lastIndex, match.index),
            });
            segmentIndex++;
        }

        // Add placeholder for the emoji (will be filled with proxied URL)
        const emoji = match[0];
        const emojiSegmentIndex = segmentIndex;
        segments.push({
            type: 'emoji',
            content: emoji,
            emojiUrl: emoji, // Temporary, will be replaced
        });

        // Start fetching the proxied URL
        emojiPromises.push({
            index: emojiSegmentIndex,
            emoji,
            promise: getProxiedEmojiUrl(emoji),
        });

        segmentIndex++;
        lastIndex = match.index + emoji.length;
    }

    // Add remaining text after the last emoji
    if (lastIndex < processedText.length) {
        segments.push({
            type: 'text',
            content: processedText.substring(lastIndex),
        });
    }

    // Wait for all emoji URLs to be fetched
    const results = await Promise.all(emojiPromises.map(p => p.promise));

    // Update emoji segments with proxied URLs
    emojiPromises.forEach((p, i) => {
        if (segments[p.index]) {
            segments[p.index].emojiUrl = results[i];
        }
    });

    return segments.length > 0 ? segments : [{ type: 'text', content: processedText }];
}
