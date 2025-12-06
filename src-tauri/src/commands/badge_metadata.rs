use crate::services::universal_cache_service::{cache_item, get_cached_item, CacheType};
use regex::Regex;
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BadgeMetadata {
    pub date_added: Option<String>,
    pub usage_stats: Option<String>,
    pub more_info: Option<String>,
    #[serde(skip_serializing)]
    pub info_url: String,
}

/// Badge metadata for caching (without URL)
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BadgeMetadataCached {
    pub date_added: Option<String>,
    pub usage_stats: Option<String>,
    pub more_info: Option<String>,
}

/// Fetch additional badge metadata information
#[tauri::command]
pub async fn fetch_badge_metadata(
    badge_set_id: String,
    badge_version: String,
) -> Result<BadgeMetadata, String> {
    // Create cache key with metadata prefix to distinguish from badge data
    let cache_key = format!("metadata:{}-v{}", badge_set_id, badge_version);

    // Construct the info URL for response
    let url = format!(
        "https://badgebase.co/badges/{}-v{}/",
        badge_set_id, badge_version
    );

    // Check universal cache first
    println!("[BadgeMetadata] Checking cache for: {}", cache_key);
    if let Ok(Some(cached)) = get_cached_item(CacheType::Badge, &cache_key).await {
        println!("[BadgeMetadata] Found in cache: {}", cache_key);
        if let Ok(cached_info) = serde_json::from_value::<BadgeMetadataCached>(cached.data) {
            // Return full info with URL
            return Ok(BadgeMetadata {
                date_added: cached_info.date_added,
                usage_stats: cached_info.usage_stats,
                more_info: cached_info.more_info,
                info_url: url,
            });
        }
    }

    println!("[BadgeMetadata] Fetching info from: {}", url);

    // Fetch the HTML page
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch badge metadata page: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Badge metadata source returned status: {}",
            response.status()
        ));
    }

    let html_content = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    // Parse the HTML and extract data in a separate scope
    let (date_added, usage_stats, more_info) = {
        let document = Html::parse_document(&html_content);
        let date_added = extract_date_added(&document);
        let usage_stats = extract_usage_stats(&document);
        let more_info = extract_more_info(&document);
        (date_added, usage_stats, more_info)
    }; // document is dropped here

    // Create cached version without URL
    let cached_info = BadgeMetadataCached {
        date_added: date_added.clone(),
        usage_stats: usage_stats.clone(),
        more_info: more_info.clone(),
    };

    // Cache the result permanently (expiry_days = 0 means never expire)
    if let Ok(json_value) = serde_json::to_value(&cached_info) {
        let _ = cache_item(
            CacheType::Badge,
            cache_key,
            json_value,
            "badgebase".to_string(),
            0, // Never expire
        )
        .await;
        println!("[BadgeMetadata] Cached badge info permanently");
    }

    // Return full info with URL
    Ok(BadgeMetadata {
        date_added,
        usage_stats,
        more_info,
        info_url: url,
    })
}

fn extract_date_added(document: &Html) -> Option<String> {
    // Look for the "Date of addition" label and get the next span
    let selector = Selector::parse("li").ok()?;

    for element in document.select(&selector) {
        let text = element.text().collect::<String>();
        if text.contains("Date of addition") {
            // Extract the date from the text
            let parts: Vec<&str> = text.split("Date of addition").collect();
            if parts.len() > 1 {
                return Some(parts[1].trim().to_string());
            }
        }
    }

    None
}

fn extract_usage_stats(document: &Html) -> Option<String> {
    // Look for the "Usage Statistics" section
    let selector = Selector::parse("li").ok()?;

    for element in document.select(&selector) {
        let text = element.text().collect::<String>();
        if text.contains("Usage Statistics") {
            // Extract the usage stats text
            let parts: Vec<&str> = text.split("Usage Statistics").collect();
            if parts.len() > 1 {
                let stats = parts[1].trim();
                // Remove "View All Statistics" link text if present
                let stats = stats.replace("View All Statistics", "").trim().to_string();
                return Some(stats);
            }
        }
    }

    None
}

fn extract_more_info(document: &Html) -> Option<String> {
    // Look for the h2 or h6 with "More Info From Us" and get the following div.text content
    let heading_selector = Selector::parse("h2.h6.text-primary, h6.text-primary").ok()?;

    for heading in document.select(&heading_selector) {
        let heading_text = heading.text().collect::<String>();
        if heading_text.contains("More Info From Us") {
            // Get the next sibling div with class "text"
            if let Some(parent) = heading.parent() {
                let div_selector = Selector::parse("div.text").ok()?;
                if let Some(div) = parent.children().find_map(|child| {
                    child.value().as_element()?;
                    let element = scraper::ElementRef::wrap(child)?;
                    if div_selector.matches(&element) {
                        Some(element)
                    } else {
                        None
                    }
                }) {
                    // Extract text but preserve data-original timestamps from timezone-converter spans
                    let mut result = String::new();
                    extract_text_with_timestamps(&div, &mut result);
                    return Some(result.trim().to_string());
                }
            }

            // Alternative: try to find the next div.text element in the document
            let mut found_heading = false;
            let all_selector = Selector::parse("*").ok()?;
            for element in document.select(&all_selector) {
                if found_heading {
                    if element.value().name() == "div" {
                        if let Some(class) = element.value().attr("class") {
                            if class.contains("text") {
                                let mut result = String::new();
                                extract_text_with_timestamps(&element, &mut result);
                                return Some(result.trim().to_string());
                            }
                        }
                    }
                }

                if element.value().name() == "h2" || element.value().name() == "h6" {
                    let text = element.text().collect::<String>();
                    if text.contains("More Info From Us") {
                        found_heading = true;
                    }
                }
            }
        }
    }

    None
}

fn extract_text_with_timestamps(element: &scraper::ElementRef, result: &mut String) {
    use scraper::node::Node;

    for child in element.children() {
        match child.value() {
            Node::Text(text) => {
                // Decode HTML entities in text
                result.push_str(&decode_html_entities(text));
            }
            Node::Element(_) => {
                if let Some(child_element) = scraper::ElementRef::wrap(child) {
                    // Check if this is a timezone-converter span
                    if child_element.value().name() == "span" {
                        if let Some(class) = child_element.value().attr("class") {
                            if class.contains("timezone-converter") {
                                // Extract the data-original attribute
                                if let Some(original_time) =
                                    child_element.value().attr("data-original")
                                {
                                    result.push_str(&decode_html_entities(original_time));
                                    continue;
                                }
                            }
                        }
                    }
                    // Recursively process child elements
                    extract_text_with_timestamps(&child_element, result);
                }
            }
            _ => {}
        }
    }
}

/// Decode HTML entities like &#8211; → – and &amp; → &
fn decode_html_entities(text: &str) -> String {
    let mut result = text.to_string();

    // Decode numeric HTML entities (&#NNNN;)
    // Match decimal entities like &#8211;
    if let Ok(decimal_re) = Regex::new(r"&#(\d+);") {
        let temp = result.clone();
        let mut last_end = 0;
        let mut new_result = String::new();

        for caps in decimal_re.captures_iter(&temp) {
            if let (Some(full_match), Some(num_str)) = (caps.get(0), caps.get(1)) {
                // Add text before this match
                new_result.push_str(&temp[last_end..full_match.start()]);

                // Try to decode the entity
                if let Ok(code_point) = num_str.as_str().parse::<u32>() {
                    if let Some(c) = char::from_u32(code_point) {
                        new_result.push(c);
                    } else {
                        new_result.push_str(full_match.as_str());
                    }
                } else {
                    new_result.push_str(full_match.as_str());
                }

                last_end = full_match.end();
            }
        }
        new_result.push_str(&temp[last_end..]);
        result = new_result;
    }

    // Match hex entities like &#x2013;
    if let Ok(hex_re) = Regex::new(r"&#x([0-9a-fA-F]+);") {
        let temp = result.clone();
        let mut last_end = 0;
        let mut new_result = String::new();

        for caps in hex_re.captures_iter(&temp) {
            if let (Some(full_match), Some(hex_str)) = (caps.get(0), caps.get(1)) {
                // Add text before this match
                new_result.push_str(&temp[last_end..full_match.start()]);

                // Try to decode the entity
                if let Ok(code_point) = u32::from_str_radix(hex_str.as_str(), 16) {
                    if let Some(c) = char::from_u32(code_point) {
                        new_result.push(c);
                    } else {
                        new_result.push_str(full_match.as_str());
                    }
                } else {
                    new_result.push_str(full_match.as_str());
                }

                last_end = full_match.end();
            }
        }
        new_result.push_str(&temp[last_end..]);
        result = new_result;
    }

    // Decode common named HTML entities
    result = result
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        .replace("&ndash;", "\u{2013}") // en-dash
        .replace("&mdash;", "\u{2014}") // em-dash
        .replace("&lsquo;", "\u{2018}") // left single quote
        .replace("&rsquo;", "\u{2019}") // right single quote
        .replace("&ldquo;", "\u{201C}") // left double quote
        .replace("&rdquo;", "\u{201D}") // right double quote
        .replace("&bull;", "\u{2022}") // bullet
        .replace("&hellip;", "\u{2026}") // ellipsis
        .replace("&copy;", "\u{00A9}") // copyright
        .replace("&reg;", "\u{00AE}") // registered
        .replace("&trade;", "\u{2122}"); // trademark

    result
}
