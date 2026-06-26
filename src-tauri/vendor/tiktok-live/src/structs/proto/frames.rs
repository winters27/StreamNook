use std::collections::BTreeMap;

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastPushFrame {
    #[prost(int64, tag = "1")]
    pub seq_id: i64,
    #[prost(int64, tag = "2")]
    pub log_id: i64,
    #[prost(int64, tag = "3")]
    pub service: i64,
    #[prost(int64, tag = "4")]
    pub method: i64,
    #[prost(btree_map = "string, string", tag = "5")]
    pub headers: BTreeMap<String, String>,
    #[prost(string, tag = "6")]
    pub payload_encoding: String,
    #[prost(string, tag = "7")]
    pub payload_type: String,
    #[prost(bytes = "vec", tag = "8")]
    pub payload: Vec<u8>,
}

#[derive(Clone, Copy, PartialEq, ::prost::Message)]
pub struct HeartbeatMessage {
    #[prost(uint64, tag = "1")]
    pub room_id: u64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastImEnterRoomMessage {
    #[prost(int64, tag = "1")]
    pub room_id: i64,
    #[prost(string, tag = "2")]
    pub room_tag: String,
    #[prost(string, tag = "3")]
    pub live_region: String,
    #[prost(int64, tag = "4")]
    pub live_id: i64,
    #[prost(string, tag = "5")]
    pub identity: String,
    #[prost(string, tag = "6")]
    pub cursor: String,
    #[prost(int64, tag = "7")]
    pub account_type: i64,
    #[prost(int64, tag = "8")]
    pub enter_unique_id: i64,
    #[prost(string, tag = "9")]
    pub filter_welcome_msg: String,
    #[prost(bool, tag = "10")]
    pub is_anchor_continue_keep_msg: bool,
}
