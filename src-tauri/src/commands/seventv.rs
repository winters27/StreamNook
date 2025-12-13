use serde::{Deserialize, Serialize};
use tauri::command;

#[derive(Debug, Serialize, Deserialize)]
pub struct GraphQLResponse {
    pub data: Option<serde_json::Value>,
    pub errors: Option<Vec<serde_json::Value>>,
    pub message: Option<String>,
}

/// Proxy GraphQL requests to 7TV API to bypass CORS restrictions
#[command]
pub async fn seventv_graphql(query: String) -> Result<GraphQLResponse, String> {
    let client = reqwest::Client::new();

    let response = client
        .post("https://7tv.io/v4/gql")
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "query": query }))
        .send()
        .await
        .map_err(|e| format!("Failed to send request to 7TV: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("7TV API returned status: {}", response.status()));
    }

    let json: GraphQLResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse 7TV response: {}", e))?;

    Ok(json)
}
