use crate::models::chat_layout::LayoutResult;
use cosmic_text::{Attrs, Buffer, Color, Family, FontSystem, Metrics, Shaping, SwashCache, Weight};
use std::sync::Mutex;
use tauri::State;

pub struct LayoutService {
    font_system: Mutex<FontSystem>,
    swash_cache: Mutex<SwashCache>,
    config: Mutex<LayoutConfig>,
}

struct LayoutConfig {
    width: f32,
    font_size: f32,
}

impl LayoutService {
    pub fn new() -> Self {
        let mut font_system = FontSystem::new();

        // Load bundled Satoshi fonts
        // We use include_bytes! to embed them in the binary
        let fonts = vec![
            include_bytes!("../../../src/assets/fonts/Satoshi-Regular.otf") as &[u8],
            include_bytes!("../../../src/assets/fonts/Satoshi-Italic.otf") as &[u8],
            include_bytes!("../../../src/assets/fonts/Satoshi-Regular.otf") as &[u8],
            include_bytes!("../../../src/assets/fonts/Satoshi-Italic.otf") as &[u8],
            include_bytes!("../../../src/assets/fonts/Satoshi-Regular.otf") as &[u8],
            include_bytes!("../../../src/assets/fonts/Satoshi-Italic.otf") as &[u8],
            include_bytes!("../../../src/assets/fonts/Satoshi-Regular.otf") as &[u8],
            include_bytes!("../../../src/assets/fonts/Satoshi-Italic.otf") as &[u8],
            include_bytes!("../../../src/assets/fonts/Satoshi-Regular.otf") as &[u8],
            include_bytes!("../../../src/assets/fonts/Satoshi-Italic.otf") as &[u8],
            include_bytes!("../../../src/assets/fonts/Satoshi-Regular.otf") as &[u8],
        ];

        let db = font_system.db_mut();
        for font_data in fonts {
            db.load_font_data(font_data.to_vec());
        }

        Self {
            font_system: Mutex::new(font_system),
            swash_cache: Mutex::new(SwashCache::new()),
            config: Mutex::new(LayoutConfig {
                width: 300.0,
                font_size: 13.0,
            }),
        }
    }

    pub fn layout_message(
        &self,
        text: &str,
        width: f32,
        font_size: f32,
        has_reply: bool,
        is_first_message: bool,
    ) -> LayoutResult {
        let mut font_system = self.font_system.lock().unwrap();

        // standard line height matching frontend's leading-tight class
        let line_height = font_size * 1.35;

        // Configure metrics
        let metrics = Metrics::new(font_size, line_height);

        // Create buffer
        let mut buffer = Buffer::new(&mut font_system, metrics);

        // Account for badges (approximately 20px width for badge container + gap)
        // This reduces available text width when badges are present
        let effective_width = width - 28.0; // badges ~20px + gap ~8px

        // Set size
        buffer.set_size(&mut font_system, effective_width.max(100.0), f32::MAX);

        // Set text with Satoshi font
        // Using "Satoshi" family name. cosmic-text should find it from the loaded data.
        let attrs = Attrs::new().family(Family::Name("Satoshi"));

        buffer.set_text(&mut font_system, text, attrs, Shaping::Advanced);

        // Shape (calculate glyphs)
        buffer.shape_until_scroll(&mut font_system, false);

        // Calculate height from layout runs (visual lines after wrapping)
        let runs = buffer.layout_runs();
        let line_count = runs.count();

        // Calculate text block height
        let text_height = if line_count > 0 {
            line_count as f32 * line_height
        } else {
            // Minimum height for empty or whitespace-only content
            line_height
        };

        // Account for emotes which are taller than text (24px vs font_size)
        // If emote height per line is more than line_height, use emote height for those lines
        let emote_height = 24.0_f32;
        let effective_line_height = line_height.max(emote_height);

        // For all messages (single or multi-line), use the larger per-line height
        // This accounts for emotes which are 24px tall
        let content_height = (line_count.max(1) as f32) * effective_line_height;

        // Add vertical padding to match frontend's message_spacing
        // Frontend uses: paddingTop/Bottom = (chatDesign?.message_spacing ?? 2) / 2
        // Plus px-3 adds horizontal padding (handled in width calculation)
        // Default message_spacing is 2, but we add some buffer for line-height differences
        let base_vertical_padding = 8.0;
        let mut height = content_height + base_vertical_padding;

        // Add height for reply indicator if this is a reply message
        // Reply indicator has: mb-1.5 (6px), border-l-2
        // Content: icon (14px) + gap (6px) + truncated text line (~16px)
        // Total approximately 32px for the reply indicator
        if has_reply {
            height += 32.0;
        }

        // Add height for first message indicator if applicable
        // First message has:
        // - mt-1.5 (6px margin) + "First message in chat" text (~16px) = 22px top indicator
        // - mb-3 (12px margin) on the content area
        // - Plus the purple gradient background extends the visual height
        // Total approximately 36px extra for first message
        if is_first_message {
            height += 36.0;
        }

        LayoutResult {
            height,
            width,
            has_reply,
            is_first_message,
        }
    }

    pub fn update_config(&self, width: f32, font_size: f32) {
        let mut config = self.config.lock().unwrap();
        config.width = width;
        config.font_size = font_size;
    }

    pub fn get_current_config(&self) -> (f32, f32) {
        let config = self.config.lock().unwrap();
        (config.width, config.font_size)
    }
}
