use prost::Message;
use tracing::trace;

use crate::structs::TikTokLiveEvent;

/// Decode a wire message into one or more events.
/// Sub-routed messages (Social, Member, Control) produce both the raw event
/// AND a convenience event (Follow, Share, Join, LiveEnded).
pub fn decode_message(msg_type: &str, payload: &[u8]) -> Vec<TikTokLiveEvent> {
    trace!("decoding {msg_type} ({} bytes)", payload.len());

    match msg_type {
        // core events (with sub-routing)
        "WebcastChatMessage" => vec1(payload, TikTokLiveEvent::Chat, msg_type),
        "WebcastGiftMessage" => vec1(payload, TikTokLiveEvent::Gift, msg_type),
        "WebcastLikeMessage" => vec1(payload, TikTokLiveEvent::Like, msg_type),
        "WebcastMemberMessage" => decode_member(payload, msg_type),
        "WebcastSocialMessage" => decode_social(payload, msg_type),
        "WebcastRoomUserSeqMessage" => vec1(payload, TikTokLiveEvent::RoomUserSeq, msg_type),
        "WebcastControlMessage" => decode_control(payload, msg_type),

        // useful events
        "WebcastLiveIntroMessage" => vec1(payload, TikTokLiveEvent::LiveIntro, msg_type),
        "WebcastRoomMessage" => vec1(payload, TikTokLiveEvent::RoomMessage, msg_type),
        "WebcastCaptionMessage" => vec1(payload, TikTokLiveEvent::Caption, msg_type),
        "WebcastGoalUpdateMessage" => vec1(payload, TikTokLiveEvent::GoalUpdate, msg_type),
        "WebcastImDeleteMessage" => vec1(payload, TikTokLiveEvent::ImDelete, msg_type),

        // niche events
        "WebcastRankUpdateMessage" => vec1(payload, TikTokLiveEvent::RankUpdate, msg_type),
        "WebcastPollMessage" => vec1(payload, TikTokLiveEvent::Poll, msg_type),
        "WebcastEnvelopeMessage" => vec1(payload, TikTokLiveEvent::Envelope, msg_type),
        "WebcastRoomPinMessage" => vec1(payload, TikTokLiveEvent::RoomPin, msg_type),
        "WebcastUnauthorizedMemberMessage" => vec1(payload, TikTokLiveEvent::UnauthorizedMember, msg_type),
        "WebcastLinkMicMethod" => vec1(payload, TikTokLiveEvent::LinkMicMethod, msg_type),
        "WebcastLinkMicBattle" => vec1(payload, TikTokLiveEvent::LinkMicBattle, msg_type),
        "WebcastLinkMicArmies" => vec1(payload, TikTokLiveEvent::LinkMicArmies, msg_type),
        "WebcastLinkMessage" => vec1(payload, TikTokLiveEvent::LinkMessage, msg_type),
        "WebcastLinkLayerMessage" => vec1(payload, TikTokLiveEvent::LinkLayer, msg_type),
        "WebcastLinkMicLayoutStateMessage" => vec1(payload, TikTokLiveEvent::LinkMicLayoutState, msg_type),
        "WebcastGiftPanelUpdateMessage" => vec1(payload, TikTokLiveEvent::GiftPanelUpdate, msg_type),
        "WebcastInRoomBannerMessage" => vec1(payload, TikTokLiveEvent::InRoomBanner, msg_type),
        "WebcastGuideMessage" => vec1(payload, TikTokLiveEvent::Guide, msg_type),

        // extended events
        "WebcastEmoteChatMessage" => vec1(payload, TikTokLiveEvent::EmoteChat, msg_type),
        "WebcastQuestionNewMessage" => vec1(payload, TikTokLiveEvent::QuestionNew, msg_type),
        "WebcastSubNotifyMessage" => vec1(payload, TikTokLiveEvent::SubNotify, msg_type),
        "WebcastBarrageMessage" => vec1(payload, TikTokLiveEvent::Barrage, msg_type),
        "WebcastHourlyRankMessage" => vec1(payload, TikTokLiveEvent::HourlyRank, msg_type),
        "WebcastMsgDetectMessage" => vec1(payload, TikTokLiveEvent::MsgDetect, msg_type),
        "WebcastLinkMicFanTicketMethod" => vec1(payload, TikTokLiveEvent::LinkMicFanTicket, msg_type),
        "WebcastRoomVerifyMessage" | "RoomVerifyMessage" => vec1(payload, TikTokLiveEvent::RoomVerify, msg_type),
        "WebcastOecLiveShoppingMessage" => vec1(payload, TikTokLiveEvent::OecLiveShopping, msg_type),
        "WebcastGiftBroadcastMessage" => vec1(payload, TikTokLiveEvent::GiftBroadcast, msg_type),
        "WebcastRankTextMessage" => vec1(payload, TikTokLiveEvent::RankText, msg_type),
        "WebcastGiftDynamicRestrictionMessage" => vec1(payload, TikTokLiveEvent::GiftDynamicRestriction, msg_type),
        "WebcastViewerPicksUpdateMessage" => vec1(payload, TikTokLiveEvent::ViewerPicksUpdate, msg_type),

        // secondary events
        "WebcastSystemMessage" => vec1(payload, TikTokLiveEvent::SystemMessage, msg_type),
        "WebcastLiveGameIntroMessage" => vec1(payload, TikTokLiveEvent::LiveGameIntro, msg_type),
        "WebcastAccessControlMessage" => vec1(payload, TikTokLiveEvent::AccessControl, msg_type),
        "WebcastAccessRecallMessage" => vec1(payload, TikTokLiveEvent::AccessRecall, msg_type),
        "WebcastAlertBoxAuditResultMessage" => vec1(payload, TikTokLiveEvent::AlertBoxAuditResult, msg_type),
        "WebcastBindingGiftMessage" => vec1(payload, TikTokLiveEvent::BindingGift, msg_type),
        "WebcastBoostCardMessage" => vec1(payload, TikTokLiveEvent::BoostCard, msg_type),
        "WebcastBottomMessage" => vec1(payload, TikTokLiveEvent::BottomMessage, msg_type),
        "WebcastGameRankNotifyMessage" => vec1(payload, TikTokLiveEvent::GameRankNotify, msg_type),
        "WebcastGiftPromptMessage" => vec1(payload, TikTokLiveEvent::GiftPrompt, msg_type),
        "WebcastLinkStateMessage" => vec1(payload, TikTokLiveEvent::LinkState, msg_type),
        "WebcastLinkMicBattlePunishFinish" => vec1(payload, TikTokLiveEvent::LinkMicBattlePunishFinish, msg_type),
        "WebcastLinkmicBattleTaskMessage" => vec1(payload, TikTokLiveEvent::LinkmicBattleTask, msg_type),
        "WebcastMarqueeAnnouncementMessage" => vec1(payload, TikTokLiveEvent::MarqueeAnnouncement, msg_type),
        "WebcastNoticeMessage" => vec1(payload, TikTokLiveEvent::Notice, msg_type),
        "WebcastNotifyMessage" => vec1(payload, TikTokLiveEvent::Notify, msg_type),
        "WebcastPartnershipDropsUpdateMessage" => vec1(payload, TikTokLiveEvent::PartnershipDropsUpdate, msg_type),
        "WebcastPartnershipGameOfflineMessage" => vec1(payload, TikTokLiveEvent::PartnershipGameOffline, msg_type),
        "WebcastPartnershipPunishMessage" => vec1(payload, TikTokLiveEvent::PartnershipPunish, msg_type),
        "WebcastPerceptionMessage" => vec1(payload, TikTokLiveEvent::Perception, msg_type),
        "WebcastSpeakerMessage" => vec1(payload, TikTokLiveEvent::Speaker, msg_type),
        "WebcastSubCapsuleMessage" => vec1(payload, TikTokLiveEvent::SubCapsule, msg_type),
        "WebcastSubPinEventMessage" => vec1(payload, TikTokLiveEvent::SubPinEvent, msg_type),
        "WebcastSubscriptionNotifyMessage" => vec1(payload, TikTokLiveEvent::SubscriptionNotify, msg_type),
        "WebcastToastMessage" => vec1(payload, TikTokLiveEvent::Toast, msg_type),

        // unknown passthrough
        _ => {
            trace!("unknown message type: {msg_type}");
            vec![TikTokLiveEvent::Unknown {
                method: msg_type.to_string(),
                payload: payload.to_vec(),
            }]
        }
    }
}

fn decode_social(payload: &[u8], msg_type: &str) -> Vec<TikTokLiveEvent> {
    use crate::structs::proto::messages::WebcastSocialMessage;
    match WebcastSocialMessage::decode(payload) {
        Ok(msg) => {
            let mut events = Vec::with_capacity(2);
            events.push(TikTokLiveEvent::Social(msg.clone()));
            match msg.action {
                1 => events.push(TikTokLiveEvent::Follow(msg)),
                2 | 3 | 4 | 5 => events.push(TikTokLiveEvent::Share(msg)),
                _ => {}
            }
            events
        }
        Err(e) => {
            tracing::warn!("failed to decode {msg_type}: {e}");
            vec![TikTokLiveEvent::Unknown { method: msg_type.to_string(), payload: payload.to_vec() }]
        }
    }
}

fn decode_member(payload: &[u8], msg_type: &str) -> Vec<TikTokLiveEvent> {
    use crate::structs::proto::messages::WebcastMemberMessage;
    match WebcastMemberMessage::decode(payload) {
        Ok(msg) => {
            let mut events = Vec::with_capacity(2);
            events.push(TikTokLiveEvent::Member(msg.clone()));
            if msg.action == 1 {
                events.push(TikTokLiveEvent::Join(msg));
            }
            events
        }
        Err(e) => {
            tracing::warn!("failed to decode {msg_type}: {e}");
            vec![TikTokLiveEvent::Unknown { method: msg_type.to_string(), payload: payload.to_vec() }]
        }
    }
}

fn decode_control(payload: &[u8], msg_type: &str) -> Vec<TikTokLiveEvent> {
    use crate::structs::proto::messages::WebcastControlMessage;
    match WebcastControlMessage::decode(payload) {
        Ok(msg) => {
            let mut events = Vec::with_capacity(2);
            events.push(TikTokLiveEvent::Control(msg.clone()));
            if msg.action == 3 {
                events.push(TikTokLiveEvent::LiveEnded(msg));
            }
            events
        }
        Err(e) => {
            tracing::warn!("failed to decode {msg_type}: {e}");
            vec![TikTokLiveEvent::Unknown { method: msg_type.to_string(), payload: payload.to_vec() }]
        }
    }
}

fn vec1<T: Message + Default>(payload: &[u8], wrap: fn(T) -> TikTokLiveEvent, msg_type: &str) -> Vec<TikTokLiveEvent> {
    match T::decode(payload) {
        Ok(msg) => vec![wrap(msg)],
        Err(e) => {
            tracing::warn!("failed to decode {msg_type}: {e}");
            vec![TikTokLiveEvent::Unknown {
                method: msg_type.to_string(),
                payload: payload.to_vec(),
            }]
        }
    }
}
