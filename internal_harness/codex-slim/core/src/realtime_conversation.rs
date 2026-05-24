use crate::codex::Session;
use codex_protocol::protocol::CodexErrorInfo;
use codex_protocol::protocol::ConversationAudioParams;
use codex_protocol::protocol::ConversationStartParams;
use codex_protocol::protocol::ConversationTextParams;
use codex_protocol::protocol::ErrorEvent;
use codex_protocol::protocol::Event;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::RealtimeConversationClosedEvent;
use std::sync::Arc;

const REALTIME_UNSUPPORTED_MESSAGE: &str =
    "realtime websocket/audio conversations are not available in this slim build";

pub(crate) struct RealtimeConversationManager;

impl RealtimeConversationManager {
    pub(crate) fn new() -> Self {
        Self
    }

    pub(crate) async fn shutdown(&self) -> crate::error::Result<()> {
        Ok(())
    }
}

pub(crate) async fn handle_start(
    sess: &Arc<Session>,
    sub_id: String,
    _params: ConversationStartParams,
) -> crate::error::Result<()> {
    send_conversation_error(
        sess,
        sub_id,
        REALTIME_UNSUPPORTED_MESSAGE.to_string(),
        CodexErrorInfo::Other,
    )
    .await;
    Ok(())
}

pub(crate) async fn handle_audio(
    sess: &Arc<Session>,
    sub_id: String,
    _params: ConversationAudioParams,
) {
    send_conversation_error(
        sess,
        sub_id,
        REALTIME_UNSUPPORTED_MESSAGE.to_string(),
        CodexErrorInfo::BadRequest,
    )
    .await;
}

pub(crate) async fn handle_text(
    sess: &Arc<Session>,
    sub_id: String,
    _params: ConversationTextParams,
) {
    send_conversation_error(
        sess,
        sub_id,
        REALTIME_UNSUPPORTED_MESSAGE.to_string(),
        CodexErrorInfo::BadRequest,
    )
    .await;
}

pub(crate) async fn handle_close(sess: &Arc<Session>, sub_id: String) {
    let _ = sess.conversation.shutdown().await;
    sess.send_event_raw(Event {
        id: sub_id,
        msg: EventMsg::RealtimeConversationClosed(RealtimeConversationClosedEvent {
            reason: Some("unsupported".to_string()),
        }),
    })
    .await;
}

async fn send_conversation_error(
    sess: &Arc<Session>,
    sub_id: String,
    message: String,
    codex_error_info: CodexErrorInfo,
) {
    sess.send_event_raw(Event {
        id: sub_id,
        msg: EventMsg::Error(ErrorEvent {
            message,
            codex_error_info: Some(codex_error_info),
        }),
    })
    .await;
}
