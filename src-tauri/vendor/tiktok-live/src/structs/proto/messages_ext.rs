// Extended + secondary message types.

use super::types::{CommonMessageData, EmoteData, MsgFilter, Text, UserIdentityContext};
use super::user::UserIdentity;

// -- Extended events (full proto fields) --

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastEmoteChatMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(message, optional, tag = "2")]
    pub user: Option<UserIdentity>,
    #[prost(message, repeated, tag = "3")]
    pub emote_list: Vec<EmoteData>,
    #[prost(message, optional, tag = "4")]
    pub msg_filter: Option<MsgFilter>,
    #[prost(message, optional, tag = "5")]
    pub user_identity: Option<UserIdentityContext>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct QuestionDetails {
    #[prost(int64, tag = "1")]
    pub question_id: i64,
    #[prost(string, tag = "2")]
    pub question_text: String,
    #[prost(int32, tag = "3")]
    pub answer_status: i32,
    #[prost(int64, tag = "4")]
    pub create_time: i64,
    #[prost(message, optional, tag = "5")]
    pub user: Option<UserIdentity>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastQuestionNewMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(message, optional, tag = "2")]
    pub details: Option<QuestionDetails>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastSubNotifyMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(message, optional, tag = "2")]
    pub sender: Option<UserIdentity>,
    #[prost(int32, tag = "3")]
    pub exhibition_type: i32,
    #[prost(int32, tag = "4")]
    pub sub_month: i32,
    #[prost(int32, tag = "5")]
    pub subscribe_type: i32,
    #[prost(int32, tag = "6")]
    pub old_subscribe_status: i32,
    #[prost(int32, tag = "7")]
    pub user_subscribe_status: i32,
    #[prost(int32, tag = "8")]
    pub subscribing_status: i32,
    #[prost(int32, tag = "9")]
    pub change_type: i32,
    #[prost(int64, tag = "10")]
    pub upgrade_count: i64,
    #[prost(message, optional, tag = "11")]
    pub user: Option<UserIdentity>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastBarrageMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(bytes = "vec", tag = "2")]
    pub event_blob: Vec<u8>,
    #[prost(int32, tag = "3")]
    pub msg_type: i32,
    #[prost(int64, tag = "6")]
    pub duration: i64,
    #[prost(int32, tag = "9")]
    pub display_config: i32,
    #[prost(int64, tag = "10")]
    pub gallery_gift_id: i64,
    #[prost(string, tag = "22")]
    pub schema: String,
    #[prost(string, tag = "23")]
    pub sub_type: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastHourlyRankMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(bytes = "vec", tag = "2")]
    pub rank_container_blob: Vec<u8>,
    #[prost(uint32, tag = "3")]
    pub data2: u32,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct MsgDetectTriggerCondition {
    #[prost(bool, tag = "1")]
    pub uplink_detect_http: bool,
    #[prost(bool, tag = "2")]
    pub uplink_detect_web_socket: bool,
    #[prost(bool, tag = "3")]
    pub detect_p2p_msg: bool,
    #[prost(bool, tag = "4")]
    pub detect_room_msg: bool,
    #[prost(bool, tag = "5")]
    pub http_optimize: bool,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct MsgDetectTimeInfo {
    #[prost(int64, tag = "1")]
    pub client_start_ms: i64,
    #[prost(int64, tag = "2")]
    pub api_recv_time_ms: i64,
    #[prost(int64, tag = "3")]
    pub api_send_to_goim_ms: i64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastMsgDetectMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int32, tag = "2")]
    pub detect_type: i32,
    #[prost(message, optional, tag = "3")]
    pub trigger_condition: Option<MsgDetectTriggerCondition>,
    #[prost(message, optional, tag = "4")]
    pub time_info: Option<MsgDetectTimeInfo>,
    #[prost(int32, tag = "5")]
    pub trigger_by: i32,
    #[prost(string, tag = "6")]
    pub from_region: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastLinkMicFanTicketMethod {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(bytes = "vec", tag = "2")]
    pub fan_ticket_room_notice_blob: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastRoomVerifyMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int32, tag = "2")]
    pub action: i32,
    #[prost(string, tag = "3")]
    pub content: String,
    #[prost(int32, tag = "4")]
    pub notice_type: i32,
    #[prost(bool, tag = "5")]
    pub close_room: bool,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastOecLiveShoppingMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(bytes = "vec", tag = "2")]
    pub shopping_data_blob: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastGiftBroadcastMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(bytes = "vec", tag = "2")]
    pub broadcast_data_blob: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastRankTextMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int32, tag = "2")]
    pub scene: i32,
    #[prost(int64, tag = "3")]
    pub owner_idx_before_update: i64,
    #[prost(int64, tag = "4")]
    pub owner_idx_after_update: i64,
    #[prost(string, tag = "5")]
    pub self_get_badge_msg: String,
    #[prost(string, tag = "6")]
    pub other_get_badge_msg: String,
    #[prost(int64, tag = "7")]
    pub cur_user_id: i64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastGiftDynamicRestrictionMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(bytes = "vec", tag = "2")]
    pub restriction_blob: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastViewerPicksUpdateMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int32, tag = "2")]
    pub update_type: i32,
    #[prost(bytes = "vec", tag = "3")]
    pub picks_blob: Vec<u8>,
}

// -- Secondary events --

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastSystemMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(string, tag = "2")]
    pub message: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastLiveGameIntroMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(bytes = "vec", tag = "2")]
    pub game_data_blob: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastAccessControlMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(bytes = "vec", tag = "2")]
    pub captcha_blob: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastAccessRecallMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int32, tag = "2")]
    pub status: i32,
    #[prost(int64, tag = "3")]
    pub duration: i64,
    #[prost(int64, tag = "4")]
    pub end_time: i64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastAlertBoxAuditResultMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int64, tag = "2")]
    pub user_id: i64,
    #[prost(int32, tag = "5")]
    pub scene: i32,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastBindingGiftMessage {
    #[prost(bytes = "vec", tag = "1")]
    pub gift_message_blob: Vec<u8>,
    #[prost(message, optional, tag = "2")]
    pub common: Option<CommonMessageData>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastBoostCardMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(bytes = "vec", tag = "2")]
    pub cards_blob: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastBottomMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(string, tag = "2")]
    pub content: String,
    #[prost(int32, tag = "3")]
    pub show_type: i32,
    #[prost(int64, tag = "5")]
    pub duration: i64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastGameRankNotifyMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int32, tag = "2")]
    pub msg_type: i32,
    #[prost(string, tag = "3")]
    pub notify_text: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastGiftPromptMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(string, tag = "2")]
    pub title: String,
    #[prost(string, tag = "3")]
    pub body: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastLinkStateMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int64, tag = "2")]
    pub channel_id: i64,
    #[prost(int32, tag = "3")]
    pub scene: i32,
    #[prost(int32, tag = "4")]
    pub version: i32,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastLinkMicBattlePunishFinish {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int64, tag = "2")]
    pub id1: i64,
    #[prost(int64, tag = "3")]
    pub timestamp: i64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastLinkmicBattleTaskMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(bytes = "vec", tag = "2")]
    pub task_data_blob: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastMarqueeAnnouncementMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int32, tag = "2")]
    pub message_scene: i32,
    #[prost(bytes = "vec", tag = "3")]
    pub entity_list_blob: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastNoticeMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(string, tag = "2")]
    pub content: String,
    #[prost(int32, tag = "3")]
    pub notice_type: i32,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastNotifyMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(string, tag = "2")]
    pub schema: String,
    #[prost(int32, tag = "3")]
    pub notify_type: i32,
    #[prost(string, tag = "4")]
    pub content_str: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastPartnershipDropsUpdateMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int32, tag = "2")]
    pub change_mode: i32,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastPartnershipGameOfflineMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(bytes = "vec", tag = "2")]
    pub offline_game_list_blob: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastPartnershipPunishMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(bytes = "vec", tag = "2")]
    pub punish_info_blob: Vec<u8>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastPerceptionMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(bytes = "vec", tag = "2")]
    pub dialog_blob: Vec<u8>,
    #[prost(int64, tag = "4")]
    pub end_time: i64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastSpeakerMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(message, optional, tag = "2")]
    pub user: Option<UserIdentity>,
    #[prost(message, optional, tag = "3")]
    pub display_text: Option<Text>,
    #[prost(int32, tag = "4")]
    pub trigger_type: i32,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastSubCapsuleMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(string, tag = "2")]
    pub description: String,
    #[prost(string, tag = "3")]
    pub btn_name: String,
    #[prost(string, tag = "4")]
    pub btn_url: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastSubPinEventMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int32, tag = "2")]
    pub action_type: i32,
    #[prost(int64, tag = "4")]
    pub operator_user_id: i64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastSubscriptionNotifyMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(message, optional, tag = "2")]
    pub user: Option<UserIdentity>,
    #[prost(int32, tag = "3")]
    pub exhibition_type: i32,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct WebcastToastMessage {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int64, tag = "2")]
    pub display_duration_ms: i64,
    #[prost(int64, tag = "3")]
    pub delay_display_duration_ms: i64,
    #[prost(string, tag = "4")]
    pub toast_text: String,
    #[prost(string, tag = "5")]
    pub button_text: String,
    #[prost(string, tag = "6")]
    pub button_schema: String,
}
