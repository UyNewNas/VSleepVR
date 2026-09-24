use super::event::{EventConfidence, EventKind, EventSource, SessionEvent};
use super::journal::{JournalError, SessionFileInfo, SessionJournal, SessionJournalStore};
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
    SessionAlreadyActive(String),
}

impl Display for RuntimeError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Journal(error) => Display::fmt(error, f),
            Self::SessionAlreadyActive(session_id) => {
                write!(f, "VSleep session is already active: {session_id}")
            }
        }
    }
}

impl Error for RuntimeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Journal(error) => Some(error),
            Self::SessionAlreadyActive(_) => None,
        }
    }
}

impl From<JournalError> for RuntimeError {
    fn from(value: JournalError) -> Self {
        Self::Journal(value)
    }
}

#[derive(Debug)]
pub struct SessionJournalRuntime {
    store: SessionJournalStore,
    active_session: Option<SessionJournal>,
}

impl SessionJournalRuntime {
    pub fn new(root: PathBuf) -> Result<Self, RuntimeError> {
        Ok(Self {
            store: SessionJournalStore::new(root)?,
            active_session: None,
        })
    }

    pub fn active_session_id(&self) -> Option<&str> {
        self.active_session
            .as_ref()
            .map(SessionJournal::session_id)
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
            return Ok(None);
        };

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
