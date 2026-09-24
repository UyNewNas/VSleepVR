use super::event::{EventConfidence, EventKind, EventSource, SessionEvent};
use super::journal::{JournalError, SessionFileInfo, SessionJournal, SessionJournalStore};
use super::sleep_inhibition::{SleepInhibitionController, SleepInhibitionError};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    error::Error,
    fmt::{Display, Formatter},
    path::PathBuf,
};

#[derive(Debug)]
pub enum RuntimeError {
    Journal(JournalError),
    SleepInhibition(SleepInhibitionError),
    SessionAlreadyActive(String),
    NoActiveSessionForSleepInhibition,
}

impl Display for RuntimeError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Journal(error) => Display::fmt(error, f),
            Self::SleepInhibition(error) => Display::fmt(error, f),
            Self::SessionAlreadyActive(session_id) => {
                write!(f, "VSleep session is already active: {session_id}")
            }
            Self::NoActiveSessionForSleepInhibition => {
                write!(f, "Windows sleep inhibition requires an active VSleep session")
            }
        }
    }
}

impl Error for RuntimeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Journal(error) => Some(error),
            Self::SleepInhibition(error) => Some(error),
            Self::SessionAlreadyActive(_) | Self::NoActiveSessionForSleepInhibition => None,
        }
    }
}

impl From<JournalError> for RuntimeError {
    fn from(value: JournalError) -> Self {
        Self::Journal(value)
    }
}

impl From<SleepInhibitionError> for RuntimeError {
    fn from(value: SleepInhibitionError) -> Self {
        Self::SleepInhibition(value)
    }
}

#[derive(Debug)]
pub struct SessionJournalRuntime {
    store: SessionJournalStore,
    active_session: Option<SessionJournal>,
    sleep_inhibition: SleepInhibitionController,
}

impl SessionJournalRuntime {
    pub fn new(root: PathBuf) -> Result<Self, RuntimeError> {
        Ok(Self {
            store: SessionJournalStore::new(root)?,
            active_session: None,
            sleep_inhibition: SleepInhibitionController::new()?,
        })
    }

    pub fn active_session_id(&self) -> Option<&str> {
        self.active_session
            .as_ref()
            .map(SessionJournal::session_id)
    }

    pub fn sleep_inhibition_active(&self) -> bool {
        self.sleep_inhibition.is_active()
    }

    pub fn start_session(&mut self) -> Result<String, RuntimeError> {
        if let Some(journal) = self.active_session.as_ref() {
            return Err(RuntimeError::SessionAlreadyActive(
                journal.session_id().to_string(),
            ));
        }

        let journal = self.store.start_session()?;
        let session_id = journal.session_id().to_string();
        self.active_session = Some(journal);
        Ok(session_id)
    }

    pub fn set_sleep_inhibition(&mut self, enabled: bool) -> Result<bool, RuntimeError> {
        if enabled && self.active_session.is_none() {
            return Err(RuntimeError::NoActiveSessionForSleepInhibition);
        }

        let changed = self.sleep_inhibition.set_enabled(enabled)?;
        if !changed {
            return Ok(self.sleep_inhibition.is_active());
        }

        let kind = if enabled {
            EventKind::SystemSleepInhibitionEnabled
        } else {
            EventKind::SystemSleepInhibitionDisabled
        };
        let mut metadata = BTreeMap::new();
        metadata.insert(
            "api".to_string(),
            Value::String("SetThreadExecutionState".to_string()),
        );
        metadata.insert("display_required".to_string(), Value::Bool(false));
        self.record_if_active(
            EventSource::WindowsPower,
            kind,
            EventConfidence::Observed,
            metadata,
        )?;

        Ok(self.sleep_inhibition.is_active())
    }

    pub fn record_if_active(
        &self,
        source: EventSource,
        kind: EventKind,
        confidence: EventConfidence,
        metadata: BTreeMap<String, Value>,
    ) -> Result<Option<SessionEvent>, RuntimeError> {
        self.active_session
            .as_ref()
            .map(|journal| journal.record(source, kind, confidence, metadata))
            .transpose()
            .map_err(RuntimeError::from)
    }

    pub fn finish_session(&mut self) -> Result<Option<SessionEvent>, RuntimeError> {
        let Some(journal) = self.active_session.as_ref() else {
            if self.sleep_inhibition.is_active() {
                self.sleep_inhibition.set_enabled(false)?;
            }
            return Ok(None);
        };

        if self.sleep_inhibition.is_active() {
            self.set_sleep_inhibition(false)?;
        }

        let event = journal.finish()?;
        self.active_session = None;
        Ok(event)
    }

    pub fn list_sessions(&self) -> Result<Vec<SessionFileInfo>, RuntimeError> {
        Ok(self.store.list_sessions()?)
    }

    pub fn read_session(&self, file_name: &str) -> Result<Vec<SessionEvent>, RuntimeError> {
        Ok(self.store.read_session_by_file_name(file_name)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owns_exactly_one_active_session_and_exposes_it_for_observers() {
        let directory = tempfile::tempdir().unwrap();
        let mut runtime = SessionJournalRuntime::new(directory.path().to_path_buf()).unwrap();

        assert!(runtime.active_session_id().is_none());
        assert!(!runtime.sleep_inhibition_active());
        assert!(matches!(
            runtime.set_sleep_inhibition(true),
            Err(RuntimeError::NoActiveSessionForSleepInhibition)
        ));
        assert!(runtime
            .record_if_active(
                EventSource::OpenVr,
                EventKind::HmdConnected,
                EventConfidence::Observed,
                BTreeMap::new(),
            )
            .unwrap()
            .is_none());

        let session_id = runtime.start_session().unwrap();
        assert_eq!(runtime.active_session_id(), Some(session_id.as_str()));
        assert!(matches!(
            runtime.start_session(),
            Err(RuntimeError::SessionAlreadyActive(active_id)) if active_id == session_id
        ));

        let event = runtime
            .record_if_active(
                EventSource::OpenVr,
                EventKind::HmdDisconnected,
                EventConfidence::Observed,
                BTreeMap::new(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(event.session_id, session_id);

        assert!(runtime.finish_session().unwrap().is_some());
        assert!(runtime.active_session_id().is_none());
        assert!(!runtime.sleep_inhibition_active());
        assert!(runtime.finish_session().unwrap().is_none());

        let sessions = runtime.list_sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        let events = runtime.read_session(&sessions[0].file_name).unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].kind, EventKind::SessionStarted);
        assert_eq!(events[1].kind, EventKind::HmdDisconnected);
        assert_eq!(events[2].kind, EventKind::SessionEnded);
    }
}
