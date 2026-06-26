#[derive(Clone, PartialEq, ::prost::Message)]
pub struct LinkerListChangeContent {
    #[prost(bytes = "vec", repeated, tag = "1")]
    pub group1_users: Vec<Vec<u8>>,
    #[prost(bytes = "vec", repeated, tag = "2")]
    pub group2_users: Vec<Vec<u8>>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct LinkerRosterEntry {
    #[prost(bytes = "vec", tag = "1")]
    pub user_blob: Vec<u8>,
    #[prost(int64, tag = "2")]
    pub event_time_hint: i64,
    #[prost(int32, tag = "4")]
    pub state: i32,
    #[prost(string, tag = "5")]
    pub link_session_key: String,
    #[prost(int64, tag = "7")]
    pub score_or_rank: i64,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct LinkerListUser {
    #[prost(int64, tag = "1")]
    pub user_id: i64,
    #[prost(string, tag = "3")]
    pub nickname: String,
    #[prost(string, tag = "38")]
    pub display_id: String,
    #[prost(string, tag = "46")]
    pub sec_uid: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct BattleUserInfo {
    #[prost(message, optional, tag = "1")]
    pub user: Option<LinkerListUser>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct BattleUserArmies {}
