// Gift sub-types: full GiftDetails, monitor info, priority, sponsorships, etc.

use super::types::{Image, Text};

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct GiftBoxInfo {
    #[prost(int64, tag = "1")]
    pub capacity: i64,
    #[prost(bool, tag = "2")]
    pub is_primary_box: bool,
    #[prost(string, tag = "3")]
    pub scheme_url: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct GiftPanelBanner {
    #[prost(message, optional, tag = "1")]
    pub display_text: Option<Text>,
    #[prost(message, optional, tag = "2")]
    pub left_icon: Option<Image>,
    #[prost(string, tag = "3")]
    pub schema_url: String,
    #[prost(string, repeated, tag = "5")]
    pub bg_colors: Vec<String>,
    #[prost(string, tag = "6")]
    pub banner_lynx_url: String,
    #[prost(int32, tag = "7")]
    pub banner_priority: i32,
    #[prost(string, tag = "8")]
    pub banner_lynx_extra: String,
    #[prost(message, optional, tag = "9")]
    pub bg_image: Option<Image>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct GiftDetails {
    #[prost(message, optional, tag = "1")]
    pub gift_image: Option<Image>,
    #[prost(string, tag = "2")]
    pub describe: String,
    #[prost(int32, tag = "4")]
    pub duration: i32,
    #[prost(int64, tag = "5")]
    pub id: i64,
    #[prost(bool, tag = "7")]
    pub for_link_mic: bool,
    #[prost(bool, tag = "10")]
    pub combo: bool,
    #[prost(int32, tag = "11")]
    pub gift_type: i32,
    #[prost(int32, tag = "12")]
    pub diamond_count: i32,
    #[prost(bool, tag = "13")]
    pub is_displayed_on_panel: bool,
    #[prost(int64, tag = "14")]
    pub primary_effect_id: i64,
    #[prost(message, optional, tag = "15")]
    pub gift_label_icon: Option<Image>,
    #[prost(string, tag = "16")]
    pub gift_name: String,
    #[prost(message, optional, tag = "21")]
    pub icon: Option<Image>,
    #[prost(string, tag = "24")]
    pub gold_effect: String,
    #[prost(message, optional, tag = "47")]
    pub preview_image: Option<Image>,
    #[prost(message, optional, tag = "48")]
    pub gift_panel_banner: Option<GiftPanelBanner>,
    #[prost(bool, tag = "49")]
    pub is_broadcast_gift: bool,
    #[prost(bool, tag = "50")]
    pub is_effect_befview: bool,
    #[prost(bool, tag = "51")]
    pub is_random_gift: bool,
    #[prost(bool, tag = "52")]
    pub is_box_gift: bool,
    #[prost(bool, tag = "53")]
    pub can_put_in_gift_box: bool,
    #[prost(message, optional, tag = "54")]
    pub gift_box_info: Option<GiftBoxInfo>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct GiftIMPriority {
    #[prost(int64, repeated, tag = "1")]
    pub queue_sizes: Vec<i64>,
    #[prost(int64, tag = "2")]
    pub self_queue_priority: i64,
    #[prost(int64, tag = "3")]
    pub priority: i64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct GiftMonitorInfo {
    #[prost(int64, tag = "1")]
    pub anchor_id: i64,
    #[prost(int64, tag = "2")]
    pub profit_api_message_dur: i64,
    #[prost(int64, tag = "3")]
    pub send_gift_profit_api_start_ms: i64,
    #[prost(int64, tag = "4")]
    pub send_gift_profit_core_start_ms: i64,
    #[prost(int64, tag = "5")]
    pub send_gift_req_start_ms: i64,
    #[prost(int64, tag = "6")]
    pub send_gift_send_message_success_ms: i64,
    #[prost(int64, tag = "7")]
    pub send_profit_api_dur: i64,
    #[prost(int64, tag = "8")]
    pub to_user_id: i64,
    #[prost(int64, tag = "9")]
    pub send_gift_start_client_local_ms: i64,
    #[prost(string, tag = "10")]
    pub from_platform: String,
    #[prost(string, tag = "11")]
    pub from_version: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct SponsorshipInfo {
    #[prost(int64, tag = "1")]
    pub gift_id: i64,
    #[prost(int64, tag = "2")]
    pub sponsor_id: i64,
    #[prost(bool, tag = "3")]
    pub light_gift_up: bool,
    #[prost(string, tag = "4")]
    pub unlighted_gift_icon: String,
    #[prost(string, tag = "5")]
    pub gift_gallery_detail_page_scheme_url: String,
    #[prost(bool, tag = "6")]
    pub gift_gallery_click_sponsor: bool,
    #[prost(bool, tag = "21")]
    pub become_all_sponsored: bool,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct MatchInfo {
    #[prost(int64, tag = "1")]
    pub critical: i64,
    #[prost(bool, tag = "2")]
    pub effect_card_in_use: bool,
    #[prost(int32, tag = "3")]
    pub multiplier_type: i32,
    #[prost(int64, tag = "4")]
    pub multiplier_value: i64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct GiftTrayInfo {
    #[prost(message, optional, tag = "1")]
    pub m_dynamic_img: Option<Image>,
    #[prost(bool, tag = "2")]
    pub can_mirror: bool,
    #[prost(message, optional, tag = "3")]
    pub tray_normal_bg_img: Option<Image>,
    #[prost(string, repeated, tag = "4")]
    pub tray_normal_bg_color: Vec<String>,
    #[prost(message, optional, tag = "5")]
    pub tray_small_bg_img: Option<Image>,
    #[prost(string, repeated, tag = "6")]
    pub tray_small_bg_color: Vec<String>,
    #[prost(message, optional, tag = "7")]
    pub right_tag_text: Option<Text>,
    #[prost(message, optional, tag = "8")]
    pub right_tag_bg_img: Option<Image>,
    #[prost(string, repeated, tag = "9")]
    pub right_tag_bg_color: Vec<String>,
    #[prost(string, tag = "10")]
    pub tray_name_text_color: String,
    #[prost(string, tag = "11")]
    pub tray_desc_text_color: String,
    #[prost(string, tag = "12")]
    pub right_tag_jump_schema: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct InteractiveGiftInfo {
    #[prost(int64, tag = "1")]
    pub cross_screen_delay: i64,
    #[prost(int64, tag = "2")]
    pub cross_screen_role: i64,
    #[prost(int64, tag = "4")]
    pub uniq_id: i64,
    #[prost(int64, tag = "5")]
    pub to_user_team_id: i64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct LynxGiftExtra {
    #[prost(int64, tag = "1")]
    pub id: i64,
    #[prost(int64, tag = "2")]
    pub code: i64,
    #[prost(int64, tag = "3")]
    pub r#type: i64,
    #[prost(string, repeated, tag = "4")]
    pub params: Vec<String>,
    #[prost(string, tag = "5")]
    pub extra: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct TextEffectDetail {
    #[prost(message, optional, tag = "1")]
    pub text: Option<Text>,
    #[prost(int32, tag = "2")]
    pub text_font_size: i32,
    #[prost(message, optional, tag = "3")]
    pub background: Option<Image>,
    #[prost(int64, tag = "4")]
    pub start: i64,
    #[prost(int64, tag = "5")]
    pub duration: i64,
    #[prost(int32, tag = "6")]
    pub x: i32,
    #[prost(int32, tag = "7")]
    pub y: i32,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct TextEffect {
    #[prost(message, optional, tag = "1")]
    pub portrait_detail: Option<TextEffectDetail>,
    #[prost(message, optional, tag = "2")]
    pub landscape_detail: Option<TextEffectDetail>,
}
