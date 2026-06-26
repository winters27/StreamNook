use std::collections::BTreeMap;
use std::io::Read;

use flate2::read::GzDecoder;
use prost::Message;

use crate::errors::TikTokLiveError;
use crate::structs::proto::frames::{HeartbeatMessage, WebcastImEnterRoomMessage, WebcastPushFrame};

pub fn build_heartbeat(room_id: &str) -> Result<Vec<u8>, TikTokLiveError> {
    let parsed: u64 = room_id.parse().map_err(|e| TikTokLiveError::invalid(format!("room_id parse u64: {e}")))?;

    let hb = HeartbeatMessage { room_id: parsed };
    let frame = WebcastPushFrame {
        seq_id: 0,
        log_id: 0,
        service: 0,
        method: 0,
        headers: BTreeMap::new(),
        payload_encoding: "pb".into(),
        payload_type: "hb".into(),
        payload: hb.encode_to_vec(),
    };
    Ok(frame.encode_to_vec())
}

pub fn build_enter_room(room_id: &str) -> Result<Vec<u8>, TikTokLiveError> {
    let parsed: u64 = room_id.parse().map_err(|e| TikTokLiveError::invalid(format!("room_id parse u64: {e}")))?;

    let msg = WebcastImEnterRoomMessage {
        room_id: parsed as i64,
        room_tag: String::new(),
        live_region: String::new(),
        live_id: 12,
        identity: "audience".into(),
        cursor: String::new(),
        account_type: 0,
        enter_unique_id: 0,
        filter_welcome_msg: "0".into(),
        is_anchor_continue_keep_msg: false,
    };
    let frame = WebcastPushFrame {
        seq_id: 0,
        log_id: 0,
        service: 0,
        method: 0,
        headers: BTreeMap::new(),
        payload_encoding: "pb".into(),
        payload_type: "im_enter_room".into(),
        payload: msg.encode_to_vec(),
    };
    Ok(frame.encode_to_vec())
}

pub fn build_ack(log_id: i64, internal_ext: &[u8]) -> Result<Vec<u8>, TikTokLiveError> {
    let frame = WebcastPushFrame {
        seq_id: 0,
        log_id,
        service: 0,
        method: 0,
        headers: BTreeMap::new(),
        payload_encoding: "pb".into(),
        payload_type: "ack".into(),
        payload: internal_ext.to_vec(),
    };
    Ok(frame.encode_to_vec())
}

pub fn decompress_if_gzipped(data: &[u8]) -> Result<Vec<u8>, TikTokLiveError> {
    if data.len() >= 2 && data[0] == 0x1f && data[1] == 0x8b {
        let mut decoder = GzDecoder::new(data);
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).map_err(|e| TikTokLiveError::decode(format!("gzip: {e}")))?;
        Ok(decompressed)
    } else {
        Ok(data.to_vec())
    }
}
