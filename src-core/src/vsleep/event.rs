use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventSource {
    Vsleep,
    OpenVr,
    SteamVr,
    VrchatProcess,
    VrchatLog,
    WindowsPower,
    SleepMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventConfidence {
    Observed,
    InferredHigh,
    InferredMedium,
    InferredLow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    SessionStarted,
    SessionEnded,
    HmdConnected,
    HmdDisconnected,
    SteamVrStarted,
    SteamVrStopped,
    SteamVrStandbyEntered,
    SteamVrStandbyExited,
    VrchatStarted,
    VrchatStopped,
    WindowsSuspend,
    WindowsResume,
    WindowsPowerEvent,
    SleepModeEnabled,
    SleepModeDisabled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionEvent {
    pub schema_version: u8,
    pub timestamp_utc: String,
    pub session_id: String,
    pub source: EventSource,
    pub kind: EventKind,
    pub confidence: EventConfidence,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub metadata: BTreeMap<String, Value>,
}

impl SessionEvent {
    pub const SCHEMA_VERSION: u8 = 1;

    pub fn new(
        session_id: impl Into<String>,
        source: EventSource,
        kind: EventKind,
        confidence: EventConfidence,
    ) -> Self {
        Self {
            schema_version: Self::SCHEMA_VERSION,
            timestamp_utc: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            session_id: session_id.into(),
            source,
            kind,
            confidence,
            metadata: BTreeMap::new(),
        }
    }

    pub fn with_metadata(mut self, metadata: BTreeMap<String, Value>) -> Self {
        self.metadata = metadata;
        self
    }
}
