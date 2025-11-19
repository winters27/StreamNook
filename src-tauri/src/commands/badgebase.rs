use serde::{Deserialize, Serialize};
use scraper::{Html, Selector};
use crate::services::universal_cache_service::{get_cached_item, cache_item, CacheType};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BadgeBaseInfo {
    pub date_added: Option<String>,
    pub usage_stats: Option<String>,
    pub more_info: Option<String>,
    pub badgebase_url: String,
}

/// Fetch additional badge information from BadgeBase.co
#[tauri::command]
pub async fn fetch_badgebase_info(
    badge_set_id: String,
    badge_version: String,
) -> Result<BadgeBaseInfo, String> {
    // Create cache key
    let cache_key = format!("{}-v{}", badge_set_id, badge_version);
    
    // Check universal cache first
    println!("[BadgeBase] Checking cache for: {}", cache_key);
    if let Ok(Some(cached)) = get_cached_item(CacheType::BadgebaseInfo, &cache_key).await {
        println!("[BadgeBase] Found in cache: {}", cache_key);
        if let Ok(info) = serde_json::from_value::<BadgeBaseInfo>(cached.data) {
            return Ok(info);
        }
    }
    
    // Construct the BadgeBase URL
    // Format: https://badgebase.co/badges/{badge-set-id}-v{version}/
    let url = format!(
        "https://badgebase.co/badges/{}-v{}/",
        badge_set_id, badge_version
    );

    println!("[BadgeBase] Fetching info from: {}", url);

    // Fetch the HTML page
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch BadgeBase page: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "BadgeBase returned status: {}",
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

    let info = BadgeBaseInfo {
        date_added,
        usage_stats,
        more_info,
        badgebase_url: url,
    };
    
    // Cache the result permanently (expiry_days = 0 means never expire)
    if let Ok(json_value) = serde_json::to_value(&info) {
        let _ = cache_item(
            CacheType::BadgebaseInfo,
            cache_key,
            json_value,
            "badgebase".to_string(),
            0, // Never expire
        ).await;
        println!("[BadgeBase] Cached badge info permanently");
    }
    
    Ok(info)
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
                result.push_str(text);
            }
            Node::Element(_) => {
                if let Some(child_element) = scraper::ElementRef::wrap(child) {
                    // Check if this is a timezone-converter span
                    if child_element.value().name() == "span" {
                        if let Some(class) = child_element.value().attr("class") {
                            if class.contains("timezone-converter") {
                                // Extract the data-original attribute
                                if let Some(original_time) = child_element.value().attr("data-original") {
                                    result.push_str(original_time);
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
