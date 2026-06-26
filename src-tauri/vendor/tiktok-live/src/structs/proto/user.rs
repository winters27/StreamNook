// Big `User` proto — appears in nearly every event (chat, gift, like, member,
// social). Tags verified against soylibs/TikTok-Live-Connector/.proto/src/data.proto.
//
// We keep the lib alias `UserIdentity` (legacy name) but the wire type is `User`.

use super::types::{
    ActivityInfo, AnchorLevel, AuthenticationInfo, Author, BadgeStruct, BorderInfo, ComboBadgeInfo,
    FansClubInfo, FansClubMember, FollowInfo, Image, PayGrade, SubscribeInfo, UserAttr, UserHonor,
};

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct OwnRoom {
    #[prost(int64, repeated, tag = "1")]
    pub room_ids: Vec<i64>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct EcommerceEntrance {
    #[prost(string, tag = "1")]
    pub url: String,
    #[prost(int32, tag = "2")]
    pub r#type: i32,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct UserIdentity {
    #[prost(int64, tag = "1")]
    pub user_id: i64,
    #[prost(string, tag = "3")]
    pub nickname: String,
    #[prost(string, tag = "5")]
    pub bio_description: String,
    #[prost(message, optional, tag = "9")]
    pub avatar_thumb: Option<Image>,
    #[prost(message, optional, tag = "10")]
    pub avatar_medium: Option<Image>,
    #[prost(message, optional, tag = "11")]
    pub avatar_large: Option<Image>,
    #[prost(bool, tag = "12")]
    pub verified: bool,
    #[prost(int32, tag = "15")]
    pub status: i32,
    #[prost(int64, tag = "16")]
    pub create_time: i64,
    #[prost(int64, tag = "17")]
    pub modify_time: i64,
    #[prost(int32, tag = "18")]
    pub secret: i32,
    #[prost(string, tag = "19")]
    pub share_qrcode_uri: String,
    #[prost(message, repeated, tag = "21")]
    pub badge_image_list: Vec<Image>,
    #[prost(message, optional, tag = "22")]
    pub follow_info: Option<FollowInfo>,
    #[prost(message, optional, tag = "23")]
    pub user_honor: Option<UserHonor>,
    #[prost(message, optional, tag = "24")]
    pub fans_club: Option<FansClubMember>,
    #[prost(message, optional, tag = "25")]
    pub border: Option<BorderInfo>,
    #[prost(string, tag = "26")]
    pub special_id: String,
    #[prost(message, optional, tag = "27")]
    pub avatar_border: Option<Image>,
    #[prost(message, optional, tag = "28")]
    pub medal: Option<Image>,
    #[prost(message, repeated, tag = "29")]
    pub user_badges: Vec<Image>,
    #[prost(message, repeated, tag = "30")]
    pub new_user_badges: Vec<Image>,
    #[prost(int32, tag = "31")]
    pub top_vip_no: i32,
    #[prost(message, optional, tag = "32")]
    pub user_attr: Option<UserAttr>,
    #[prost(message, optional, tag = "33")]
    pub own_room: Option<OwnRoom>,
    #[prost(int64, tag = "34")]
    pub pay_score: i64,
    #[prost(int64, tag = "35")]
    pub fan_ticket_count: i64,
    #[prost(message, optional, tag = "36")]
    pub anchor_info: Option<AnchorLevel>,
    /// Wire-level enum (`UserLinkmicStatus`); decoded as raw int32.
    #[prost(int32, tag = "37")]
    pub link_mic_stats: i32,
    #[prost(string, tag = "38")]
    pub unique_id: String,
    #[prost(bool, tag = "39")]
    pub enable_show_commerce_sale: bool,
    #[prost(bool, tag = "40")]
    pub with_fusion_shop_entry: bool,
    #[prost(int64, tag = "41")]
    pub pay_scores: i64,
    #[prost(message, optional, tag = "42")]
    pub anchor_level: Option<AnchorLevel>,
    #[prost(string, tag = "43")]
    pub verified_content: String,
    #[prost(message, optional, tag = "44")]
    pub author_info: Option<Author>,
    #[prost(message, repeated, tag = "45")]
    pub top_fans: Vec<UserIdentity>,
    #[prost(string, tag = "46")]
    pub sec_uid: String,
    #[prost(int32, tag = "47")]
    pub user_role: i32,
    #[prost(message, optional, tag = "49")]
    pub reward_info: Option<ActivityInfo>,
    #[prost(message, optional, tag = "52")]
    pub personal_card: Option<Image>,
    #[prost(message, optional, tag = "53")]
    pub authentication_info: Option<AuthenticationInfo>,
    #[prost(message, repeated, tag = "57")]
    pub media_badge_image_list: Vec<Image>,
    #[prost(int64, repeated, tag = "60")]
    pub commerce_webcast_config_ids: Vec<i64>,
    #[prost(message, repeated, tag = "61")]
    pub borders: Vec<BorderInfo>,
    #[prost(message, optional, tag = "62")]
    pub combo_badge_info: Option<ComboBadgeInfo>,
    #[prost(message, optional, tag = "63")]
    pub subscribe_info: Option<SubscribeInfo>,
    #[prost(message, repeated, tag = "64")]
    pub badge_list: Vec<BadgeStruct>,
    #[prost(int64, repeated, tag = "65")]
    pub mint_type_label: Vec<i64>,
    #[prost(message, optional, tag = "66")]
    pub fans_club_info: Option<FansClubInfo>,
    #[prost(message, optional, tag = "67")]
    pub pay_grade: Option<PayGrade>,
    #[prost(bool, tag = "1002")]
    pub allow_find_by_contacts: bool,
    #[prost(bool, tag = "1003")]
    pub allow_others_download_video: bool,
    #[prost(bool, tag = "1004")]
    pub allow_others_download_when_sharing_video: bool,
    #[prost(bool, tag = "1005")]
    pub allow_share_show_profile: bool,
    #[prost(bool, tag = "1006")]
    pub allow_show_in_gossip: bool,
    #[prost(bool, tag = "1007")]
    pub allow_show_my_action: bool,
    #[prost(bool, tag = "1008")]
    pub allow_strange_comment: bool,
    #[prost(bool, tag = "1009")]
    pub allow_unfollower_comment: bool,
    #[prost(bool, tag = "1010")]
    pub allow_use_linkmic: bool,
    #[prost(message, optional, tag = "1012")]
    pub avatar_jpg: Option<Image>,
    #[prost(string, tag = "1013")]
    pub background_img_url: String,
    #[prost(int32, tag = "1016")]
    pub block_status: i32,
    #[prost(int32, tag = "1017")]
    pub comment_restrict: i32,
    #[prost(string, tag = "1018")]
    pub constellation: String,
    #[prost(int32, tag = "1019")]
    pub disable_ichat: i32,
    #[prost(int64, tag = "1020")]
    pub enable_ichat_img: i64,
    #[prost(int32, tag = "1021")]
    pub exp: i32,
    #[prost(bool, tag = "1023")]
    pub fold_stranger_chat: bool,
    #[prost(int64, tag = "1024")]
    pub follow_status: i64,
    #[prost(int32, tag = "1027")]
    pub ichat_restrict_type: i32,
    #[prost(string, tag = "1028")]
    pub id_str: String,
    #[prost(bool, tag = "1029")]
    pub is_follower: bool,
    #[prost(bool, tag = "1030")]
    pub is_following: bool,
    #[prost(bool, tag = "1031")]
    pub need_profile_guide: bool,
    #[prost(bool, tag = "1033")]
    pub push_comment_status: bool,
    #[prost(bool, tag = "1034")]
    pub push_digg: bool,
    #[prost(bool, tag = "1035")]
    pub push_follow: bool,
    #[prost(bool, tag = "1036")]
    pub push_friend_action: bool,
    #[prost(bool, tag = "1037")]
    pub push_ichat: bool,
    #[prost(bool, tag = "1038")]
    pub push_status: bool,
    #[prost(bool, tag = "1039")]
    pub push_video_post: bool,
    #[prost(bool, tag = "1040")]
    pub push_video_recommend: bool,
    #[prost(string, tag = "1043")]
    pub verified_reason: String,
    #[prost(bool, tag = "1044")]
    pub enable_car_management_permission: bool,
    #[prost(string, tag = "1046")]
    pub scm_label: String,
    #[prost(message, optional, tag = "1047")]
    pub ecommerce_entrance: Option<EcommerceEntrance>,
    #[prost(bool, tag = "1048")]
    pub is_block: bool,
    #[prost(bool, tag = "1090")]
    pub is_subscribe: bool,
    #[prost(bool, tag = "1091")]
    pub is_anchor_marked: bool,
}
