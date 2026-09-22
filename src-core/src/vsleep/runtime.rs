use super::event::{EventConfidence, EventKind, EventSource, SessionEvent};
use super::journal::{JournalError, SessionFileInfo, SessionJournal, SessionJournalStore};
use super::timeline::{build_session_report, SessionReport};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    error::Error,
    fmt::{Display, Formatter},
    path::PathBuf,
};
use uuid::Uuid;

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

    pub fn read_session_report(&self, file_name: &str) -> Result<SessionReport, RuntimeError> {
        let events = self.read_session(file_name)?;
        let report_events = match canonical_session_id(file_name) {
            Some(session_id) => events
                .into_iter()
                .filter(|event| event.session_id == session_id)
                .collect(),
            None => events,
        };
        Ok(build_session_report(&report_events))
    }
}

fn canonical_session_id(file_name: &str) -> Option<&str> {
    let stem = file_name.strip_suffix(".jsonl")?;
    let (timestamp, session_id) = stem.split_once('-')?;
    if timestamp.len() != 20
        || !timestamp.bytes().all(|byte| byte.is_ascii_digit())
        || Uuid::parse_str(session_id).is_err()
    {
        return None;
    }
    Some(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs::OpenOptions, io::Write};

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

    #[test]
    fn builds_report_directly_from_persisted_session_file() {
        let directory = tempfile::tempdir().unwrap();
        let mut runtime = SessionJournalRuntime::new(directory.path().to_path_buf()).unwrap();

        let session_id = runtime.start_session().unwrap();
        for (source, kind) in [
            (EventSource::SteamVr, EventKind::SteamVrStarted),
            (EventSource::VrchatProcess, EventKind::VrchatStarted),
            (EventSource::OpenVr, EventKind::HmdDisconnected),
        ] {
            runtime
                .record_if_active(
                    source,
                    kind,
                    EventConfidence::Observed,
                    BTreeMap::new(),
                )
                .unwrap();
        }
        runtime.finish_session().unwrap();

        let sessions = runtime.list_sessions().unwrap();
        let report = runtime
            .read_session_report(&sessions[0].file_name)
            .unwrap();

        assert_eq!(report.session_id.as_deref(), Some(session_id.as_str()));
        assert_eq!(report.observations.len(), 5);
        assert_eq!(report.classifications.len(), 1);
        assert_eq!(
            report.classifications[0].category,
            crate::vsleep::FailureClass::HmdOrLinkFailure
        );
    }

    #[test]
    fn canonical_session_report_quarantines_foreign_session_events() {
        let directory = tempfile::tempdir().unwrap();
        let mut runtime = SessionJournalRuntime::new(directory.path().to_path_buf()).unwrap();

        let session_id = runtime.start_session().unwrap();
        runtime.finish_session().unwrap();

        let sessions = runtime.list_sessions().unwrap();
        let file_name = &sessions[0].file_name;
        let foreign_event = SessionEvent::new(
            "foreign-session",
            EventSource::WindowsPower,
            EventKind::WindowsSuspend,
            EventConfidence::Observed,
        );
        let mut file = OpenOptions::new()
            .append(true)
            .open(directory.path().join(file_name))
            .unwrap();
        writeln!(file, "{}", serde_json::to_string(&foreign_event).unwrap()).unwrap();

        let raw_events = runtime.read_session(file_name).unwrap();
        assert_eq!(raw_events.len(), 3);

        let report = runtime.read_session_report(file_name).unwrap();
        assert_eq!(report.session_id.as_deref(), Some(session_id.as_str()));
        assert_eq!(report.observations.len(), 2);
        assert!(report
            .observations
            .iter()
            .all(|event| event.session_id == session_id));
        assert!(report.classifications.is_empty());
    }
}
