//! "/song" recognition command: decode the captured PCM and identify the track.

use crate::services::song_id::{self, SongMatch};
use base64::{engine::general_purpose, Engine};

/// Identify the song from a base64-encoded little-endian i16 mono 16 kHz PCM
/// buffer (captured frontend-side from the active player). Returns `None` when
/// no match is found.
#[tauri::command]
pub async fn identify_song(audio_b64: String) -> Result<Option<SongMatch>, String> {
    let bytes = general_purpose::STANDARD
        .decode(audio_b64.as_bytes())
        .map_err(|e| format!("bad audio payload: {}", e))?;

    if bytes.len() % 2 != 0 {
        return Err("audio payload has an odd byte length".to_string());
    }

    // Reinterpret the byte stream as little-endian i16 samples.
    let samples: Vec<i16> = bytes
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect();

    song_id::identify(samples).await
}
