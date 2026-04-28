use serde::{Deserialize, Serialize};

use crate::message::Message;

/// Mutable conversation state. The agent appends to this on every turn.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Conversation {
    pub messages: Vec<Message>,
}

impl Conversation {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_system(prompt: impl Into<String>) -> Self {
        Self {
            messages: vec![Message::system(prompt)],
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
