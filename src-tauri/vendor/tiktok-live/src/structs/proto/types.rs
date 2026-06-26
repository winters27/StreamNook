// Shared sub-types used across multiple Webcast messages.
// Mirrors `data.proto` from upstream — every field tag verified against
// soylibs/TikTok-Live-Connector/.proto/src/data.proto.

use std::collections::BTreeMap;

// -- Image / media --

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct Image {
    #[prost(string, repeated, tag = "1")]
    pub url_list: Vec<String>,
    #[prost(string, tag = "2")]
    pub uri: String,
    #[prost(int32, tag = "3")]
    pub height: i32,
    #[prost(int32, tag = "4")]
    pub width: i32,
    #[prost(string, tag = "5")]
    pub avg_color: String,
    #[prost(int32, tag = "6")]
    pub image_type: i32,
    #[prost(string, tag = "7")]
    pub schema: String,
    #[prost(message, optional, tag = "8")]
    pub content: Option<ImageContent>,
    #[prost(bool, tag = "9")]
    pub is_animated: bool,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct ImageContent {
    #[prost(string, tag = "1")]
    pub name: String,
    #[prost(string, tag = "2")]
    pub font_color: String,
    #[prost(int64, tag = "3")]
    pub level: i64,
}

// -- Text (translation key + formatted pieces) --

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct TextFormat {
    #[prost(string, tag = "1")]
    pub color: String,
    #[prost(bool, tag = "2")]
    pub bold: bool,
    #[prost(bool, tag = "3")]
    pub italic: bool,
    #[prost(int32, tag = "4")]
    pub weight: i32,
    #[prost(int32, tag = "5")]
    pub italic_angle: i32,
    #[prost(int32, tag = "6")]
    pub font_size: i32,
    #[prost(bool, tag = "7")]
    pub use_high_light_color: bool,
    #[prost(bool, tag = "8")]
    pub use_remote_color: bool,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct PatternRef {
    #[prost(string, tag = "1")]
    pub key: String,
    #[prost(string, tag = "2")]
    pub default_pattern: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct TextPieceUser {
    #[prost(message, optional, tag = "1")]
    pub user: Option<crate::structs::proto::user::UserIdentity>,
    #[prost(bool, tag = "2")]
    pub with_colon: bool,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct TextPieceGift {
    #[prost(int32, tag = "1")]
    pub gift_id: i32,
    #[prost(message, optional, tag = "2")]
    pub name_ref: Option<PatternRef>,
    #[prost(int32, tag = "3")]
    pub show_type: i32,
    #[prost(int64, tag = "4")]
    pub color_id: i64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct TextPiece {
    #[prost(int32, tag = "1")]
    pub r#type: i32,
    #[prost(message, optional, tag = "2")]
    pub format: Option<TextFormat>,
    #[prost(string, tag = "11")]
    pub string_value: String,
    #[prost(message, optional, tag = "21")]
    pub user_value: Option<TextPieceUser>,
    #[prost(message, optional, tag = "22")]
    pub gift_value: Option<TextPieceGift>,
    #[prost(message, optional, tag = "24")]
    pub pattern_ref_value: Option<PatternRef>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct Text {
    #[prost(string, tag = "1")]
    pub key: String,
    #[prost(string, tag = "2")]
    pub default_pattern: String,
    #[prost(message, optional, tag = "3")]
    pub default_format: Option<TextFormat>,
    #[prost(message, repeated, tag = "4")]
    pub pieces: Vec<TextPiece>,
}

// -- FollowInfo / FansClub / Subscribe --

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct FollowInfo {
    #[prost(int64, tag = "1")]
    pub following_count: i64,
    #[prost(int64, tag = "2")]
    pub follower_count: i64,
    #[prost(int64, tag = "3")]
    pub follow_status: i64,
    #[prost(int64, tag = "4")]
    pub push_status: i64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct UserBadge {
    #[prost(btree_map = "string, message", tag = "1")]
    pub icons: BTreeMap<String, Image>,
    #[prost(string, tag = "2")]
    pub title: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct FansClubData {
    #[prost(string, tag = "1")]
    pub club_name: String,
    #[prost(int32, tag = "2")]
    pub level: i32,
    #[prost(int32, tag = "3")]
    pub user_fans_club_status: i32,
    #[prost(message, optional, tag = "4")]
    pub badge: Option<UserBadge>,
    #[prost(int64, repeated, tag = "5")]
    pub available_gift_ids: Vec<i64>,
    #[prost(int64, tag = "6")]
    pub anchor_id: i64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct FansClubMember {
    #[prost(message, optional, tag = "1")]
    pub data: Option<FansClubData>,
    #[prost(btree_map = "string, message", tag = "2")]
    pub prefer_data: BTreeMap<String, FansClubData>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct FansClubInfo {
    #[prost(int64, tag = "2")]
    pub fans_level: i64,
    #[prost(int64, tag = "3")]
    pub fans_score: i64,
    #[prost(int64, tag = "5")]
    pub fans_count: i64,
    #[prost(string, tag = "6")]
    pub fans_club_name: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct SubscribeInfo {
    #[prost(bool, tag = "2")]
    pub is_subscribe: bool,
    #[prost(int64, tag = "5")]
    pub subscriber_count: i64,
}

// -- User mod flags / verification --

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct UserAttr {
    #[prost(bool, tag = "1")]
    pub is_muted: bool,
    #[prost(bool, tag = "2")]
    pub is_admin: bool,
    #[prost(bool, tag = "3")]
    pub is_super_admin: bool,
    #[prost(int64, tag = "4")]
    pub mute_duration: i64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct AuthenticationInfo {
    #[prost(string, tag = "1")]
    pub custom_verify: String,
    #[prost(string, tag = "2")]
    pub enterprise_verify_reason: String,
    #[prost(message, optional, tag = "3")]
    pub authentication_badge: Option<Image>,
}

// -- Badge sub-types --

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct PrivilegeLogExtra {
    #[prost(string, tag = "1")]
    pub data_version: String,
    #[prost(string, tag = "2")]
    pub privilege_id: String,
    #[prost(string, tag = "3")]
    pub privilege_version: String,
    #[prost(string, tag = "4")]
    pub privilege_order_id: String,
    #[prost(string, tag = "5")]
    pub level: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct ImageBadge {
    #[prost(int32, tag = "1")]
    pub badge_display_type: i32,
    #[prost(message, optional, tag = "2")]
    pub image: Option<Image>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct TextBadge {
    #[prost(int32, tag = "1")]
    pub badge_display_type: i32,
    #[prost(string, tag = "2")]
    pub key: String,
    #[prost(string, tag = "3")]
    pub default_pattern: String,
    #[prost(string, repeated, tag = "4")]
    pub pieces: Vec<String>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct StringBadge {
    #[prost(int32, tag = "1")]
    pub badge_display_type: i32,
    #[prost(string, tag = "2")]
    pub str_value: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct CombineBadgeBackground {
    #[prost(message, optional, tag = "1")]
    pub image: Option<Image>,
    #[prost(string, tag = "2")]
    pub background_color_code: String,
    #[prost(string, tag = "3")]
    pub border_color_code: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct FontStyle {
    #[prost(int32, tag = "1")]
    pub font_size: i32,
    #[prost(int32, tag = "2")]
    pub font_width: i32,
    #[prost(string, tag = "3")]
    pub font_color: String,
    #[prost(string, tag = "4")]
    pub border_color: String,
}

/// Used inside `CombineBadge.text`. Distinct from `TextBadge` (which has an
/// extra leading enum at tag 1).
#[derive(Clone, PartialEq, ::prost::Message)]
pub struct BadgeText {
    #[prost(string, tag = "1")]
    pub key: String,
    #[prost(string, tag = "2")]
    pub default_pattern: String,
    #[prost(string, repeated, tag = "3")]
    pub pieces: Vec<String>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct CombineBadge {
    #[prost(int32, tag = "1")]
    pub badge_display_type: i32,
    #[prost(message, optional, tag = "2")]
    pub icon: Option<Image>,
    #[prost(message, optional, tag = "3")]
    pub text: Option<BadgeText>,
    #[prost(string, tag = "4")]
    pub str_value: String,
    #[prost(message, optional, tag = "6")]
    pub font_style: Option<FontStyle>,
    #[prost(message, optional, tag = "11")]
    pub background: Option<CombineBadgeBackground>,
    #[prost(message, optional, tag = "12")]
    pub background_dark_mode: Option<CombineBadgeBackground>,
    #[prost(bool, tag = "13")]
    pub icon_auto_mirrored: bool,
    #[prost(bool, tag = "14")]
    pub bg_auto_mirrored: bool,
    #[prost(int32, tag = "15")]
    pub public_screen_show_style: i32,
    #[prost(int32, tag = "16")]
    pub personal_card_show_style: i32,
    #[prost(int32, tag = "17")]
    pub rank_list_online_audience_show_style: i32,
    #[prost(int32, tag = "18")]
    pub multi_guest_show_style: i32,
}

/// `badge_scene` enum:
/// UNKNOWN=0, ADMIN=1, FIRST_RECHARGE=2, FRIENDS=3, SUBSCRIBER=4, ACTIVITY=5,
/// RANK_LIST=6, NEW_SUBSCRIBER=7, USER_GRADE=8, STATE_CONTROLLED_MEDIA=9,
/// FANS=10, LIVE_PRO=11, ANCHOR=12.
#[derive(Clone, PartialEq, ::prost::Message)]
pub struct BadgeStruct {
    #[prost(int32, tag = "1")]
    pub display_type: i32,
    #[prost(int32, tag = "2")]
    pub priority_type: i32,
    #[prost(int32, tag = "3")]
    pub badge_scene: i32,
    #[prost(int32, tag = "4")]
    pub position: i32,
    #[prost(int32, tag = "5")]
    pub display_status: i32,
    #[prost(int64, tag = "6")]
    pub greyed_by_client: i64,
    #[prost(int32, tag = "7")]
    pub exhibition_type: i32,
    #[prost(string, tag = "10")]
    pub schema_url: String,
    #[prost(bool, tag = "11")]
    pub display: bool,
    #[prost(message, optional, tag = "12")]
    pub log_extra: Option<PrivilegeLogExtra>,
    #[prost(message, optional, tag = "20")]
    pub image_badge: Option<ImageBadge>,
    #[prost(message, optional, tag = "21")]
    pub text_badge: Option<TextBadge>,
    #[prost(message, optional, tag = "22")]
    pub string_badge: Option<StringBadge>,
    #[prost(message, optional, tag = "23")]
    pub combine_badge: Option<CombineBadge>,
    #[prost(bool, tag = "24")]
    pub is_customized: bool,
}

// -- Border, ComboBadge, ActivityInfo --

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct BorderInfo {
    #[prost(message, optional, tag = "1")]
    pub icon: Option<Image>,
    #[prost(int64, tag = "2")]
    pub level: i64,
    #[prost(string, tag = "3")]
    pub source: String,
    #[prost(message, optional, tag = "4")]
    pub profile_decoration_ribbon: Option<Image>,
    #[prost(string, tag = "7")]
    pub avatar_background_color: String,
    #[prost(string, tag = "8")]
    pub avatar_background_border_color: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct ComboBadgeInfo {
    #[prost(message, optional, tag = "1")]
    pub icon: Option<Image>,
    #[prost(int64, tag = "2")]
    pub combo_count: i64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct ActivityInfo {
    #[prost(message, optional, tag = "1")]
    pub badge: Option<Image>,
    #[prost(message, optional, tag = "2")]
    pub storytag: Option<Image>,
}

// -- Anchor / Author --

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct AnchorLevel {
    #[prost(int64, tag = "1")]
    pub level: i64,
    #[prost(int64, tag = "2")]
    pub experience: i64,
    #[prost(int64, tag = "3")]
    pub lowest_experience_this_level: i64,
    #[prost(int64, tag = "4")]
    pub highest_experience_this_level: i64,
    #[prost(message, optional, tag = "12")]
    pub stage_level: Option<Image>,
    #[prost(message, optional, tag = "13")]
    pub small_icon: Option<Image>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct Author {
    #[prost(int64, tag = "1")]
    pub video_total_count: i64,
    #[prost(int64, tag = "2")]
    pub video_total_play_count: i64,
    #[prost(int64, tag = "6")]
    pub video_total_favorite_count: i64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct UserHonor {
    #[prost(int64, tag = "1")]
    pub total_diamond: i64,
    #[prost(message, optional, tag = "2")]
    pub diamond_icon: Option<Image>,
    #[prost(string, tag = "3")]
    pub current_honor_name: String,
    #[prost(message, optional, tag = "4")]
    pub current_honor_icon: Option<Image>,
    #[prost(int32, tag = "6")]
    pub level: i32,
    #[prost(int64, tag = "9")]
    pub current_diamond: i64,
    #[prost(int64, tag = "25")]
    pub score: i64,
}

// -- PayGrade (User.pay_grade is the live "gifter level" struct) --

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct GradeIcon {
    #[prost(message, optional, tag = "1")]
    pub icon: Option<Image>,
    #[prost(int64, tag = "2")]
    pub icon_diamond: i64,
    #[prost(int64, tag = "3")]
    pub level: i64,
    #[prost(string, tag = "4")]
    pub level_str: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct PayGrade {
    #[prost(int64, tag = "1")]
    pub total_diamond_count: i64,
    #[prost(message, optional, tag = "2")]
    pub diamond_icon: Option<Image>,
    #[prost(string, tag = "3")]
    pub name: String,
    #[prost(message, optional, tag = "4")]
    pub icon: Option<Image>,
    #[prost(string, tag = "5")]
    pub next_name: String,
    #[prost(int64, tag = "6")]
    pub level: i64,
    #[prost(message, optional, tag = "7")]
    pub next_icon: Option<Image>,
    #[prost(int64, tag = "8")]
    pub next_diamond: i64,
    #[prost(int64, tag = "9")]
    pub now_diamond: i64,
    #[prost(int64, tag = "10")]
    pub this_grade_min_diamond: i64,
    #[prost(int64, tag = "11")]
    pub this_grade_max_diamond: i64,
    #[prost(int32, tag = "12")]
    pub pay_grade_describe: i32,
    #[prost(message, optional, tag = "13")]
    pub upgrade_need_consume: Option<Image>,
    #[prost(string, tag = "14")]
    pub next_privileges: String,
    #[prost(int64, tag = "15")]
    pub screen_chat_type: i64,
    #[prost(message, optional, tag = "16")]
    pub im_icon: Option<Image>,
    #[prost(message, optional, tag = "17")]
    pub im_icon_with_level: Option<Image>,
    #[prost(message, optional, tag = "18")]
    pub live_icon: Option<Image>,
    #[prost(message, optional, tag = "20")]
    pub new_im_icon_with_level: Option<Image>,
    #[prost(message, optional, tag = "21")]
    pub new_live_icon: Option<Image>,
    #[prost(int64, tag = "22")]
    pub upgrade_need_consume_2: i64,
    #[prost(string, tag = "23")]
    pub next_privileges_2: String,
    #[prost(message, repeated, tag = "26")]
    pub grade_icon_list: Vec<GradeIcon>,
    #[prost(int64, tag = "25")]
    pub score: i64,
    #[prost(string, tag = "1001")]
    pub grade_banner: String,
}

// -- Common message header --

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct CommonMessageData {
    #[prost(string, tag = "1")]
    pub method: String,
    #[prost(int64, tag = "2")]
    pub msg_id: i64,
    #[prost(int64, tag = "3")]
    pub room_id: i64,
    #[prost(int64, tag = "4")]
    pub create_time: i64,
    #[prost(int32, tag = "5")]
    pub monitor: i32,
    #[prost(bool, tag = "6")]
    pub is_show_msg: bool,
    #[prost(string, tag = "7")]
    pub describe: String,
    #[prost(message, optional, tag = "8")]
    pub display_text: Option<Text>,
    #[prost(int64, tag = "9")]
    pub fold_type: i64,
    #[prost(int64, tag = "10")]
    pub anchor_fold_type: i64,
    #[prost(int64, tag = "11")]
    pub priority_score: i64,
    #[prost(string, tag = "12")]
    pub log_id: String,
    #[prost(string, tag = "13")]
    pub msg_process_filter_k: String,
    #[prost(string, tag = "14")]
    pub msg_process_filter_v: String,
    #[prost(string, tag = "15")]
    pub from_idc: String,
    #[prost(string, tag = "16")]
    pub to_idc: String,
    #[prost(string, repeated, tag = "17")]
    pub filter_msg_tags: Vec<String>,
    #[prost(int64, tag = "21")]
    pub anchor_priority_score: i64,
    #[prost(int64, tag = "22")]
    pub room_message_heat_level: i64,
    #[prost(int64, tag = "23")]
    pub fold_type_for_web: i64,
    #[prost(int64, tag = "24")]
    pub anchor_fold_type_for_web: i64,
    #[prost(int64, tag = "25")]
    pub client_send_time: i64,
    #[prost(int32, tag = "26")]
    pub dispatch_strategy: i32,
}

// -- UserIdentity context ("user_identity" embedded in events) --

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct UserIdentityContext {
    #[prost(bool, tag = "1")]
    pub is_gift_giver_of_anchor: bool,
    #[prost(bool, tag = "2")]
    pub is_subscriber_of_anchor: bool,
    #[prost(bool, tag = "3")]
    pub is_mutual_following_with_anchor: bool,
    #[prost(bool, tag = "4")]
    pub is_follower_of_anchor: bool,
    #[prost(bool, tag = "5")]
    pub is_moderator_of_anchor: bool,
    #[prost(bool, tag = "6")]
    pub is_anchor: bool,
}

// -- Chat helpers (Emote) --

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct EmoteDetails {
    #[prost(string, tag = "1")]
    pub emote_id: String,
    #[prost(message, optional, tag = "2")]
    pub image: Option<Image>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct EmoteData {
    #[prost(int32, tag = "1")]
    pub place_in_comment: i32,
    #[prost(message, optional, tag = "2")]
    pub emote: Option<EmoteDetails>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct MsgFilter {
    #[prost(bool, tag = "1")]
    pub is_gifter: bool,
    #[prost(bool, tag = "2")]
    pub is_subscribed_to_anchor: bool,
}

// -- PublicArea(Common|MessageCommon) --

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct PublicAreaCommon {
    #[prost(message, optional, tag = "1")]
    pub user_label: Option<Image>,
    #[prost(int64, tag = "2")]
    pub user_consume_in_room: i64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct PortraitTagItem {
    #[prost(int32, tag = "1")]
    pub tag_type: i32,
    #[prost(message, optional, tag = "2")]
    pub tag_text: Option<Text>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct PortraitTopic {
    #[prost(int32, tag = "1")]
    pub topic_action_type: i32,
    #[prost(message, optional, tag = "2")]
    pub topic_text: Option<Text>,
    #[prost(message, optional, tag = "3")]
    pub topic_tips: Option<Text>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct CreatorSuccessInfo {
    #[prost(message, repeated, tag = "1")]
    pub tags: Vec<PortraitTagItem>,
    #[prost(message, optional, tag = "2")]
    pub topic: Option<PortraitTopic>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct UserMetricsItem {
    #[prost(int32, tag = "1")]
    pub r#type: i32,
    #[prost(string, tag = "2")]
    pub metrics_value: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct PortraitTag {
    #[prost(string, tag = "1")]
    pub tag_id: String,
    #[prost(int64, tag = "2")]
    pub priority: i64,
    #[prost(string, tag = "3")]
    pub show_value: String,
    #[prost(string, tag = "4")]
    pub show_args: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct PortraitInfo {
    #[prost(message, repeated, tag = "1")]
    pub user_metrics: Vec<UserMetricsItem>,
    #[prost(message, repeated, tag = "2")]
    pub portrait_tag: Vec<PortraitTag>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct UserInteractionInfo {
    #[prost(int64, tag = "1")]
    pub like_cnt: i64,
    #[prost(int64, tag = "2")]
    pub comment_cnt: i64,
    #[prost(int64, tag = "3")]
    pub share_cnt: i64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct PublicAreaMessageCommon {
    #[prost(int64, tag = "1")]
    pub scroll_gap_count: i64,
    #[prost(int64, tag = "2")]
    pub anchor_scroll_gap_count: i64,
    #[prost(bool, tag = "3")]
    pub release_to_scroll_area: bool,
    #[prost(bool, tag = "4")]
    pub anchor_release_to_scroll_area: bool,
    #[prost(bool, tag = "5")]
    pub is_anchor_marked: bool,
    #[prost(message, optional, tag = "6")]
    pub creator_success_info: Option<CreatorSuccessInfo>,
    #[prost(message, optional, tag = "7")]
    pub portrait_info: Option<PortraitInfo>,
    #[prost(message, optional, tag = "8")]
    pub user_interaction_info: Option<UserInteractionInfo>,
    #[prost(int64, tag = "9")]
    pub admin_fold_type: i64,
}
