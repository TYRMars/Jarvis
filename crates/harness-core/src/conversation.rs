use serde::{Deserialize, Serialize};

use crate::message::Message;

/// Mutable conversation state. The agent appends to this on every turn.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Conversation {
    pub messages: Vec<Message>,
    /// Provider-issued id of the most recent terminal Responses-API
    /// completion in this conversation, when chaining is enabled.
    /// Used to send `previous_response_id` on the next request and
    /// reuse the server's cached state. `None` outside Responses
    /// flavours and after any chain breaker (Reset, model swap,
    /// system-prompt change, etc.). Serde-default + skip-if-none so
    /// existing on-disk rows round-trip unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_response_id: Option<String>,
    /// Index in `messages` where the chain currently anchored at
    /// `last_response_id` began. `None` when chaining is off.
    /// Compaction must keep messages with index < this value intact
    /// (they're already on the server side and dropping them would
    /// make the wire inconsistent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_response_chain_origin: Option<usize>,
}

impl Conversation {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_system(prompt: impl Into<String>) -> Self {
        Self {
            messages: vec![Message::system(prompt)],
            ..Self::default()
        }
    }

    pub fn push(&mut self, message: Message) -> &mut Self {
        self.messages.push(message);
        self
    }

    pub fn last_assistant_text(&self) -> Option<&str> {
        for msg in self.messages.iter().rev() {
            if let Message::Assistant {
                content: Some(text),
                ..
            } = msg
            {
                return Some(text.as_str());
            }
        }
        None
    }
}
