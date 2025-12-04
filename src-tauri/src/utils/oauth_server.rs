use anyhow::Result;
use std::net::SocketAddr;
use tokio::sync::mpsc::{channel, Receiver, Sender};
use warp::Filter;

pub struct OAuthCallbackData {
    pub code: String,
    pub state: Option<String>,
}

pub async fn start_oauth_server() -> Result<(u16, Receiver<OAuthCallbackData>)> {
    let (tx, rx) = channel(1);
    // Use fixed port 3000 to match Twitch app redirect URI configuration
    let port = 3000;
    let addr = SocketAddr::from(([127, 0, 0, 1], port));

    let tx_clone = tx.clone();

    // Define filter outside spawn to avoid lifetime issues in warp 0.4
    let callback = warp::path("callback")
        .and(warp::query::<std::collections::HashMap<String, String>>())
        .and(warp::any().map(move || tx_clone.clone()))
        .and_then(handle_callback)
        .boxed();

    let server = warp::serve(callback).run(addr);
    tokio::spawn(server);

    Ok((port, rx))
}

async fn handle_callback(
    query: std::collections::HashMap<String, String>,
    tx: Sender<OAuthCallbackData>,
) -> Result<Box<dyn warp::Reply>, warp::Rejection> {
    if let Some(code) = query.get("code") {
        let callback_data = OAuthCallbackData {
            code: code.clone(),
            state: query.get("state").cloned(),
        };
        tx.send(callback_data).await.ok();

        // Return a nice HTML page
        let html = r#"
<!DOCTYPE html>
<html>
<head>
    <title>StreamNook - Authentication Successful</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }
        .container {
            background: white;
            padding: 3rem;
            border-radius: 1rem;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            text-align: center;
            max-width: 400px;
        }
        h1 {
            color: #667eea;
            margin-bottom: 1rem;
        }
        p {
            color: #666;
            line-height: 1.6;
        }
        .checkmark {
            font-size: 4rem;
            color: #4CAF50;
            margin-bottom: 1rem;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="checkmark">✓</div>
        <h1>Authentication Successful!</h1>
        <p>You have successfully logged in to StreamNook.</p>
        <p>You can now close this window and return to the app.</p>
    </div>
</body>
</html>
        "#;

        Ok(Box::new(warp::reply::html(html)))
    } else if let Some(error) = query.get("error") {
        let error_description = query
            .get("error_description")
            .map(|s| s.as_str())
            .unwrap_or("Unknown error");

        let html = format!(
            r#"
<!DOCTYPE html>
<html>
<head>
    <title>StreamNook - Authentication Failed</title>
    <style>
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
        }}
        .container {{
            background: white;
            padding: 3rem;
            border-radius: 1rem;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            text-align: center;
            max-width: 400px;
        }}
        h1 {{
            color: #f5576c;
            margin-bottom: 1rem;
        }}
        p {{
            color: #666;
            line-height: 1.6;
        }}
        .error-icon {{
            font-size: 4rem;
            color: #f5576c;
            margin-bottom: 1rem;
        }}
    </style>
</head>
<body>
    <div class="container">
        <div class="error-icon">✗</div>
        <h1>Authentication Failed</h1>
        <p><strong>Error:</strong> {}</p>
        <p>{}</p>
        <p>Please close this window and try again.</p>
    </div>
</body>
</html>
        "#,
            error, error_description
        );

        Ok(Box::new(warp::reply::html(html)))
    } else {
        Err(warp::reject::not_found())
    }
}
