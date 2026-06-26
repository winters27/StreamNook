// Core Webcast event messages.
//
// Sub-types live in `types.rs` (Image/Text/Badge/...), `user.rs` (UserIdentity),
// and `gift_types.rs` (GiftDetails/Priority/Monitor/...).
// All field tags verified against soylibs/TikTok-Live-Connector/.proto/src/webcast.proto.

use std::collections::BTreeMap;

use super::gift_types::{
    GiftDetails, GiftIMPriority, GiftMonitorInfo, GiftTrayInfo, InteractiveGiftInfo,
    LynxGiftExtra, MatchInfo, SponsorshipInfo, TextEffect,
};
use super::linker::{BattleUserArmies, BattleUserInfo};
use super::types::{
    BadgeStruct, CommonMessageData, EmoteData, Image, MsgFilter, PublicAreaCommon,
    PublicAreaMessageCommon, Text, UserIdentityContext,
};
use super::user::UserIdentity;

// -- response container --

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastResponse {
    #[prost(message, repeated, tag = "1")]
    pub messages: Vec<WebcastMessage>,
    #[prost(string, tag = "2")]
    pub cursor: String,
    #[prost(int64, tag = "3")]
    pub fetch_interval: i64,
    #[prost(int64, tag = "4")]
    pub now: i64,
    #[prost(string, tag = "5")]
    pub internal_ext: String,
    #[prost(int32, tag = "6")]
    pub fetch_type: i32,
    #[prost(btree_map = "string, string", tag = "7")]
    pub route_params_map: BTreeMap<String, String>,
    #[prost(int32, tag = "8")]
    pub heart_beat_duration: i32,
    #[prost(bool, tag = "9")]
    pub needs_ack: bool,
    #[prost(string, tag = "10")]
    pub push_server: String,
    #[prost(bool, tag = "11")]
    pub is_first: bool,
    #[prost(string, tag = "12")]
    pub history_comment_cursor: String,
    #[prost(bool, tag = "13")]
    pub history_no_more: bool,
}

#[derive(Clone, PartialEq, Eq, Hash, ::prost::Message)]
pub struct WebcastMessage {
    #[prost(string, tag = "1")]
    pub r#type: String,
    #[prost(bytes = "vec", tag = "2")]
    pub payload: Vec<u8>,
    #[prost(int64, tag = "3")]
    pub msg_id: i64,
    #[prost(int32, tag = "4")]
    pub msg_type: i32,
    #[prost(int64, tag = "5")]
    pub offset: i64,
    #[prost(bool, tag = "6")]
    pub is_history: bool,
}

// -- core events --

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct CommentTag {
    #[prost(int32, tag = "1")]
    pub tag: i32,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastChatMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(message, optional, tag = "2")]
    pub user: Option<UserIdentity>,
    #[prost(string, tag = "3")]
    pub comment: String,
    #[prost(bool, tag = "4")]
    pub visible_to_sender: bool,
    #[prost(message, optional, tag = "5")]
    pub background: Option<Image>,
    #[prost(string, tag = "6")]
    pub full_screen_text_color: String,
    #[prost(message, optional, tag = "7")]
    pub background_image_v2: Option<Image>,
    #[prost(message, optional, tag = "9")]
    pub public_area_common: Option<PublicAreaCommon>,
    #[prost(message, optional, tag = "10")]
    pub gift_image: Option<Image>,
    #[prost(int32, tag = "11")]
    pub input_type: i32,
    #[prost(message, optional, tag = "12")]
    pub at_user: Option<UserIdentity>,
    #[prost(message, repeated, tag = "13")]
    pub emotes: Vec<EmoteData>,
    #[prost(string, tag = "14")]
    pub content_language: String,
    #[prost(message, optional, tag = "15")]
    pub msg_filter: Option<MsgFilter>,
    #[prost(int32, tag = "16")]
    pub quick_chat_scene: i32,
    #[prost(int32, tag = "17")]
    pub communityflagged_status: i32,
    #[prost(message, optional, tag = "18")]
    pub user_identity: Option<UserIdentityContext>,
    #[prost(int32, repeated, tag = "20")]
    pub comment_tag: Vec<i32>,
    #[prost(message, optional, tag = "21")]
    pub public_area_message_common: Option<PublicAreaMessageCommon>,
    #[prost(int64, tag = "22")]
    pub screen_time: i64,
    #[prost(string, tag = "23")]
    pub signature: String,
    #[prost(string, tag = "24")]
    pub signature_version: String,
    #[prost(string, tag = "25")]
    pub ec_streamer_key: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastLikeMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int32, tag = "2")]
    pub like_count: i32,
    #[prost(int64, tag = "3")]
    pub total_like_count: i64,
    #[prost(int32, tag = "4")]
    pub color: i32,
    #[prost(message, optional, tag = "5")]
    pub user: Option<UserIdentity>,
    #[prost(string, tag = "6")]
    pub icon: String,
    #[prost(message, repeated, tag = "7")]
    pub icons: Vec<Image>,
    #[prost(int64, tag = "9")]
    pub effect_cnt: i64,
    #[prost(message, optional, tag = "11")]
    pub public_area_message_common: Option<PublicAreaMessageCommon>,
    #[prost(int64, tag = "12")]
    pub room_message_heat_level: i64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastGiftMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int32, tag = "2")]
    pub gift_id: i32,
    #[prost(int64, tag = "3")]
    pub fan_ticket_count: i64,
    #[prost(int32, tag = "4")]
    pub group_count: i32,
    #[prost(int32, tag = "5")]
    pub repeat_count: i32,
    #[prost(int32, tag = "6")]
    pub combo_count: i32,
    #[prost(message, optional, tag = "7")]
    pub user: Option<UserIdentity>,
    #[prost(message, optional, tag = "8")]
    pub to_user: Option<UserIdentity>,
    #[prost(int32, tag = "9")]
    pub repeat_end: i32,
    #[prost(message, optional, tag = "10")]
    pub text_effect: Option<TextEffect>,
    #[prost(uint64, tag = "11")]
    pub group_id: u64,
    #[prost(int64, tag = "12")]
    pub income_taskgifts: i64,
    #[prost(int64, tag = "13")]
    pub room_fan_ticket_count: i64,
    #[prost(message, optional, tag = "14")]
    pub priority: Option<GiftIMPriority>,
    #[prost(message, optional, tag = "15")]
    pub gift_details: Option<GiftDetails>,
    #[prost(string, tag = "16")]
    pub log_id: String,
    #[prost(int64, tag = "17")]
    pub send_type: i64,
    #[prost(message, optional, tag = "18")]
    pub public_area_common: Option<PublicAreaCommon>,
    #[prost(message, optional, tag = "19")]
    pub tray_display_text: Option<Text>,
    #[prost(int64, tag = "20")]
    pub banned_display_effects: i64,
    #[prost(message, optional, tag = "21")]
    pub tray_info: Option<GiftTrayInfo>,
    #[prost(string, tag = "22")]
    pub monitor_extra: String,
    #[prost(message, optional, tag = "23")]
    pub gift_extra: Option<GiftMonitorInfo>,
    #[prost(int64, tag = "24")]
    pub color_id: i64,
    #[prost(bool, tag = "25")]
    pub is_first_sent: bool,
    #[prost(message, optional, tag = "26")]
    pub display_text_for_anchor: Option<Text>,
    #[prost(message, optional, tag = "27")]
    pub display_text_for_audience: Option<Text>,
    #[prost(string, tag = "28")]
    pub order_id: String,
    #[prost(message, optional, tag = "30")]
    pub msg_filter: Option<MsgFilter>,
    #[prost(message, repeated, tag = "31")]
    pub lynx_extra: Vec<LynxGiftExtra>,
    #[prost(message, optional, tag = "32")]
    pub user_identity: Option<UserIdentityContext>,
    #[prost(message, optional, tag = "33")]
    pub match_info: Option<MatchInfo>,
    #[prost(int32, tag = "34")]
    pub linkmic_gift_expression_strategy: i32,
    #[prost(bytes = "vec", tag = "35")]
    pub flying_mic_resources_blob: Vec<u8>,
    #[prost(bool, tag = "36")]
    pub disable_gift_tracking: bool,
    #[prost(bytes = "vec", tag = "37")]
    pub asset_blob: Vec<u8>,
    #[prost(bytes = "vec", tag = "29")]
    pub gifts_in_box_blob: Vec<u8>,
    #[prost(bytes = "vec", tag = "40")]
    pub flying_mic_resources_v2_blob: Vec<u8>,
    #[prost(int32, tag = "38")]
    pub version: i32,
    #[prost(message, repeated, tag = "39")]
    pub sponsorship_info: Vec<SponsorshipInfo>,
    #[prost(message, optional, tag = "41")]
    pub public_area_message_common: Option<PublicAreaMessageCommon>,
    #[prost(string, tag = "42")]
    pub signature: String,
    #[prost(string, tag = "43")]
    pub signature_version: String,
    #[prost(bool, tag = "44")]
    pub multi_generate_message: bool,
    #[prost(string, tag = "45")]
    pub to_member_id: String,
    #[prost(int64, tag = "46")]
    pub to_member_id_int: i64,
    #[prost(string, tag = "47")]
    pub to_member_nickname: String,
    #[prost(message, optional, tag = "48")]
    pub interactive_gift_info: Option<InteractiveGiftInfo>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastMemberMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(message, optional, tag = "2")]
    pub user: Option<UserIdentity>,
    #[prost(int32, tag = "3")]
    pub member_count: i32,
    #[prost(message, optional, tag = "4")]
    pub operator: Option<UserIdentity>,
    #[prost(bool, tag = "5")]
    pub is_set_to_admin: bool,
    #[prost(bool, tag = "6")]
    pub is_top_user: bool,
    #[prost(int32, tag = "7")]
    pub rank_score: i32,
    #[prost(int32, tag = "8")]
    pub top_user_no: i32,
    #[prost(int32, tag = "9")]
    pub enter_type: i32,
    #[prost(int32, tag = "10")]
    pub action: i32,
    #[prost(string, tag = "11")]
    pub action_description: String,
    #[prost(int64, tag = "12")]
    pub user_id: i64,
    #[prost(string, tag = "14")]
    pub pop_str: String,
    #[prost(message, optional, tag = "17")]
    pub background: Option<Image>,
    #[prost(message, optional, tag = "18")]
    pub anchor_display_text: Option<Text>,
    #[prost(string, tag = "19")]
    pub client_enter_source: String,
    #[prost(string, tag = "20")]
    pub client_enter_type: String,
    #[prost(string, tag = "21")]
    pub client_live_reason: String,
    #[prost(int64, tag = "22")]
    pub action_duration: i64,
    #[prost(string, tag = "23")]
    pub user_share_type: String,
    #[prost(int32, tag = "24")]
    pub display_style: i32,
    #[prost(int32, tag = "26")]
    pub kick_source: i32,
    #[prost(int64, tag = "27")]
    pub allow_preview_time: i64,
    #[prost(int64, tag = "28")]
    pub last_subscription_action: i64,
    #[prost(message, optional, tag = "29")]
    pub public_area_message_common: Option<PublicAreaMessageCommon>,
    #[prost(int64, tag = "30")]
    pub live_sub_only_tier: i64,
    #[prost(int64, tag = "31")]
    pub live_sub_only_month: i64,
    #[prost(string, tag = "32")]
    pub ec_streamer_key: String,
    #[prost(int64, tag = "33")]
    pub show_wave: i64,
    #[prost(int32, tag = "35")]
    pub hit_ab_status: i32,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct Contributor {
    #[prost(int64, tag = "1")]
    pub score: i64,
    #[prost(message, optional, tag = "2")]
    pub user: Option<UserIdentity>,
    #[prost(int64, tag = "3")]
    pub rank: i64,
    #[prost(int64, tag = "4")]
    pub delta: i64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastRoomUserSeqMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(message, repeated, tag = "2")]
    pub ranks_list: Vec<Contributor>,
    #[prost(int64, tag = "3")]
    pub viewer_count: i64,
    #[prost(string, tag = "4")]
    pub pop_str: String,
    #[prost(message, repeated, tag = "5")]
    pub seats_list: Vec<Contributor>,
    #[prost(int64, tag = "6")]
    pub popularity: i64,
    #[prost(int64, tag = "7")]
    pub total_user: i64,
    #[prost(int64, tag = "8")]
    pub anonymous: i64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastSocialMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(message, optional, tag = "2")]
    pub user: Option<UserIdentity>,
    #[prost(int64, tag = "3")]
    pub share_type: i64,
    #[prost(int64, tag = "4")]
    pub action: i64,
    #[prost(string, tag = "5")]
    pub share_target: String,
    #[prost(int64, tag = "6")]
    pub follow_count: i64,
    #[prost(int64, tag = "7")]
    pub share_display_style: i64,
    #[prost(int32, tag = "8")]
    pub share_count: i32,
    #[prost(message, optional, tag = "9")]
    pub public_area_message_common: Option<PublicAreaMessageCommon>,
    #[prost(string, tag = "10")]
    pub signature: String,
    #[prost(string, tag = "11")]
    pub signature_version: String,
    #[prost(int64, tag = "12")]
    pub show_duration_ms: i64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastLiveIntroMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int64, tag = "2")]
    pub id: i64,
    #[prost(int32, tag = "3")]
    pub audit_status: i32,
    #[prost(string, tag = "4")]
    pub content: String,
    #[prost(message, optional, tag = "5")]
    pub user: Option<UserIdentity>,
    #[prost(int32, tag = "6")]
    pub intro_mode: i32,
    #[prost(message, repeated, tag = "7")]
    pub badges: Vec<BadgeStruct>,
    #[prost(string, tag = "8")]
    pub content_language: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastRoomMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(string, tag = "2")]
    pub content: String,
    #[prost(bool, tag = "3")]
    pub supprot_landscape: bool,
    #[prost(int32, tag = "4")]
    pub source: i32,
    #[prost(message, optional, tag = "5")]
    pub icon: Option<Image>,
    #[prost(int32, tag = "6")]
    pub scene: i32,
    #[prost(bool, tag = "7")]
    pub is_welcome: bool,
    #[prost(message, optional, tag = "8")]
    pub public_area_common: Option<PublicAreaMessageCommon>,
    #[prost(int64, tag = "9")]
    pub show_duration_ms: i64,
    #[prost(string, tag = "10")]
    pub sub_scene: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct CaptionContent {
    #[prost(string, tag = "1")]
    pub language: String,
    #[prost(string, tag = "2")]
    pub text: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastCaptionMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int64, tag = "2")]
    pub timestamp_ms: i64,
    #[prost(int64, tag = "3")]
    pub duration_ms: i64,
    #[prost(message, repeated, tag = "4")]
    pub content: Vec<CaptionContent>,
    #[prost(int64, tag = "5")]
    pub sentence_id: i64,
    #[prost(int64, tag = "6")]
    pub sequence_id: i64,
    #[prost(bool, tag = "7")]
    pub definite: bool,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastControlExtra {
    #[prost(int64, tag = "2")]
    pub reason_no: i64,
    #[prost(string, tag = "8")]
    pub source: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastControlMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int32, tag = "2")]
    pub action: i32,
    #[prost(string, tag = "3")]
    pub tips: String,
    #[prost(message, optional, tag = "4")]
    pub extra: Option<WebcastControlExtra>,
    #[prost(int32, tag = "9")]
    pub float_style: i32,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastGoalUpdateMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(bytes = "vec", tag = "2")]
    pub indicator_blob: Vec<u8>,
    #[prost(bytes = "vec", tag = "3")]
    pub goal_blob: Vec<u8>,
    #[prost(int64, tag = "4")]
    pub contributor_id: i64,
    #[prost(message, optional, tag = "5")]
    pub contributor_avatar: Option<Image>,
    #[prost(string, tag = "6")]
    pub contributor_display_id: String,
    #[prost(bytes = "vec", tag = "7")]
    pub contribute_subgoal_blob: Vec<u8>,
    #[prost(int64, tag = "9")]
    pub contribute_count: i64,
    #[prost(int64, tag = "10")]
    pub contribute_score: i64,
    #[prost(int64, tag = "11")]
    pub gift_repeat_count: i64,
    #[prost(string, tag = "12")]
    pub contributor_id_str: String,
    #[prost(bool, tag = "13")]
    pub pin: bool,
    #[prost(bool, tag = "14")]
    pub unpin: bool,
    #[prost(bytes = "vec", tag = "15")]
    pub pin_info_blob: Vec<u8>,
    #[prost(int32, tag = "16")]
    pub update_source: i32,
    #[prost(string, tag = "17")]
    pub goal_extra: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastImDeleteMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int64, repeated, tag = "2")]
    pub delete_msg_ids_list: Vec<i64>,
    #[prost(int64, repeated, tag = "3")]
    pub delete_user_ids_list: Vec<i64>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastRankUpdate {
    #[prost(int64, tag = "1")]
    pub rank_type: i64,
    #[prost(int64, tag = "2")]
    pub owner_rank: i64,
    #[prost(bool, tag = "5")]
    pub show_entrance_animation: bool,
    #[prost(int64, tag = "6")]
    pub countdown: i64,
    #[prost(int64, tag = "8")]
    pub related_tab_rank_type: i64,
    #[prost(int64, tag = "9")]
    pub request_first_show_type: i64,
    #[prost(int64, tag = "10")]
    pub supported_version: i64,
    #[prost(bool, tag = "11")]
    pub owner_on_rank: bool,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastRankTabInfo {
    #[prost(int64, tag = "1")]
    pub rank_type: i64,
    #[prost(string, tag = "2")]
    pub title: String,
    #[prost(int64, tag = "4")]
    pub list_lynx_type: i64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastRankUpdateMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(message, repeated, tag = "2")]
    pub updates_list: Vec<WebcastRankUpdate>,
    #[prost(int64, tag = "3")]
    pub group_type: i64,
    #[prost(int64, tag = "5")]
    pub priority: i64,
    #[prost(message, repeated, tag = "6")]
    pub tabs_list: Vec<WebcastRankTabInfo>,
    #[prost(bool, tag = "7")]
    pub is_animation_loop_play: bool,
    #[prost(bool, tag = "8")]
    pub animation_loop_for_off: bool,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastPollMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int32, tag = "2")]
    pub message_type: i32,
    #[prost(int64, tag = "3")]
    pub poll_id: i64,
    #[prost(bytes = "vec", tag = "4")]
    pub start_content_blob: Vec<u8>,
    #[prost(bytes = "vec", tag = "5")]
    pub end_content_blob: Vec<u8>,
    #[prost(bytes = "vec", tag = "6")]
    pub update_content_blob: Vec<u8>,
    #[prost(int32, tag = "7")]
    pub poll_kind: i32,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct EnvelopeInfo {
    #[prost(string, tag = "1")]
    pub envelope_id: String,
    #[prost(int32, tag = "2")]
    pub business_type: i32,
    #[prost(string, tag = "3")]
    pub envelope_idc: String,
    #[prost(string, tag = "4")]
    pub send_user_name: String,
    #[prost(int32, tag = "5")]
    pub diamond_count: i32,
    #[prost(int32, tag = "6")]
    pub people_count: i32,
    #[prost(int32, tag = "7")]
    pub unpack_at: i32,
    #[prost(string, tag = "8")]
    pub send_user_id: String,
    #[prost(message, optional, tag = "9")]
    pub send_user_avatar: Option<Image>,
    #[prost(string, tag = "10")]
    pub create_at: String,
    #[prost(string, tag = "11")]
    pub room_id: String,
    #[prost(int32, tag = "12")]
    pub follow_show_status: i32,
    #[prost(int32, tag = "13")]
    pub skin_id: i32,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastEnvelopeMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(message, optional, tag = "2")]
    pub envelope_info: Option<EnvelopeInfo>,
    #[prost(int32, tag = "3")]
    pub display: i32,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastRoomPinMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(bytes = "vec", tag = "2")]
    pub pinned_message: Vec<u8>,
    #[prost(string, tag = "30")]
    pub original_msg_type: String,
    #[prost(uint64, tag = "31")]
    pub timestamp: u64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastUnauthorizedMemberMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int32, tag = "2")]
    pub action: i32,
    #[prost(message, optional, tag = "3")]
    pub nick_name_prefix: Option<Text>,
    #[prost(string, tag = "4")]
    pub nick_name: String,
    #[prost(message, optional, tag = "5")]
    pub enter_text: Option<Text>,
}

// -- LinkMic / Battle (kept simple — most fields are ephemeral co-stream cruft) --

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastLinkMicMethod {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int32, tag = "2")]
    pub message_type: i32,
    #[prost(int64, tag = "5")]
    pub user_id: i64,
    #[prost(int64, tag = "8")]
    pub channel_id: i64,
    #[prost(int64, tag = "21")]
    pub to_user_id: i64,
    #[prost(int64, tag = "26")]
    pub start_time_ms: i64,
    #[prost(string, tag = "37")]
    pub anchor_link_mic_id_str: String,
    #[prost(int64, tag = "38")]
    pub rival_anchor_id: i64,
    #[prost(string, tag = "40")]
    pub rival_linkmic_id_str: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastLinkMicBattle {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int64, tag = "2")]
    pub battle_id: i64,
    #[prost(int32, tag = "4")]
    pub action: i32,
    #[prost(btree_map = "int64, message", tag = "5")]
    pub battle_result: BTreeMap<i64, BattleUserArmies>,
    #[prost(btree_map = "int64, message", tag = "9")]
    pub armies: BTreeMap<i64, BattleUserArmies>,
    #[prost(btree_map = "int64, message", tag = "10")]
    pub anchor_info: BTreeMap<i64, BattleUserInfo>,
    #[prost(message, repeated, tag = "14")]
    pub team_users: Vec<BattleUserArmies>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastLinkMicArmies {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int64, tag = "2")]
    pub battle_id: i64,
    #[prost(btree_map = "int64, message", tag = "3")]
    pub battle_items: BTreeMap<i64, BattleUserArmies>,
    #[prost(int64, tag = "4")]
    pub channel_id: i64,
    #[prost(int32, tag = "7")]
    pub battle_status: i32,
    #[prost(int64, tag = "8")]
    pub from_user_id: i64,
    #[prost(int64, tag = "9")]
    pub gift_id: i64,
    #[prost(int32, tag = "10")]
    pub gift_count: i32,
    #[prost(int32, tag = "12")]
    pub total_diamond_count: i32,
    #[prost(int32, tag = "13")]
    pub repeat_count: i32,
    #[prost(message, repeated, tag = "14")]
    pub team_armies: Vec<BattleUserArmies>,
    #[prost(bool, tag = "15")]
    pub trigger_critical_strike: bool,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastLinkMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int32, tag = "2")]
    pub message_type: i32,
    #[prost(int64, tag = "3")]
    pub linker_id: i64,
    #[prost(int32, tag = "4")]
    pub scene: i32,
    #[prost(bytes = "vec", tag = "20")]
    pub list_change_content_blob: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastLinkLayerMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int32, tag = "2")]
    pub message_type: i32,
    #[prost(int64, tag = "3")]
    pub channel_id: i64,
    #[prost(int32, tag = "4")]
    pub scene: i32,
    #[prost(string, tag = "5")]
    pub source: String,
    #[prost(string, tag = "6")]
    pub centerized_idc: String,
    #[prost(int64, tag = "7")]
    pub rtc_room_id: i64,
    #[prost(bytes = "vec", tag = "118")]
    pub group_change_blob: Vec<u8>,
    #[prost(bytes = "vec", tag = "200")]
    pub business_blob: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastLinkMicLayoutStateMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int64, tag = "2")]
    pub room_id: i64,
    #[prost(int32, tag = "3")]
    pub layout_state: i32,
    #[prost(string, tag = "6")]
    pub layout_key: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastGiftPanelUpdateMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int64, tag = "2")]
    pub room_id: i64,
    #[prost(int64, tag = "3")]
    pub panel_ts_or_version: i64,
    #[prost(bytes = "vec", tag = "10")]
    pub panel_blob: Vec<u8>,
    #[prost(bytes = "vec", tag = "11")]
    pub gift_list_blob: Vec<u8>,
    #[prost(bytes = "vec", tag = "12")]
    pub vault_blob: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastInRoomBannerMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(bytes = "vec", repeated, tag = "2")]
    pub raw_data_entries: Vec<Vec<u8>>,
    #[prost(int32, tag = "3")]
    pub position: i32,
    #[prost(int32, tag = "4")]
    pub action_type: i32,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastGuideMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int32, tag = "2")]
    pub guide_type: i32,
    #[prost(int64, tag = "5")]
    pub duration_ms: i64,
    #[prost(string, tag = "7")]
    pub scene: String,
}
