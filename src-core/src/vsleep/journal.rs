use super::event::{EventConfidence, EventKind, EventSource, SessionEvent};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    error::Error,
    fmt::{Display, Formatter},
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

pub const DEFAULT_MAX_SESSION_FILES: usize = 32;

#[derive(Debug)]
pub enum JournalError {
    Io(std::io::Error),
    Json(serde_json::Error),
}

impl Display for JournalError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "session journal I/O error: {error}"),
            Self::Json(error) => write!(f, "session journal JSON error: {error}"),
        }
    }
}

impl Error for JournalError {}

impl From<std::io::Error> for JournalError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for JournalError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

#[derive(Debug, Clone)]
pub struct SessionJournalStore {
    root: PathBuf,
    max_session_files: usize,
}

impl SessionJournalStore {
    pub fn new(root: PathBuf) -> Result<Self, JournalError> {
        Self::with_retention(root, DEFAULT_MAX_SESSION_FILES)
    }

    pub fn with_retention(root: PathBuf, max_session_files: usize) -> Result<Self, JournalError> {
        if max_session_files == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "session journal retention must keep at least one file",
            )
            .into());
        }
        fs::create_dir_all(&root)?;
        Ok(Self {
            root,
            max_session_files,
        })
    }

    pub fn start_session(&self) -> Result<SessionJournal, JournalError> {
        self.prune_for_new_session()?;

        let session_id = Uuid::new_v4().to_string();
        let timestamp = chrono::Utc::now().timestamp_millis();
        let path = self
            .root
            .join(format!("{timestamp:020}-{session_id}.jsonl"));
        let file = OpenOptions::new()
            .append(true)
            .create_new(true)
            .open(&path)?;
        let journal = SessionJournal {
            session_id,
            path,
            state: Mutex::new(WriterState {
                writer: BufWriter::new(file),
                ended: false,
            }),
        };
        journal.record(
            EventSource::Vsleep,
            EventKind::SessionStarted,
            EventConfidence::Observed,
            BTreeMap::new(),
        )?;
        Ok(journal)
    }

    pub fn read_session(&self, path: &Path) -> Result<Vec<SessionEvent>, JournalError> {
        let file = File::open(path)?;
        BufReader::new(file)
            .lines()
            .map(|line| {
                let line = line?;
                Ok(serde_json::from_str(&line)?)
            })
            .collect()
    }

    pub fn session_files(&self) -> Result<Vec<PathBuf>, JournalError> {
        let mut files = fs::read_dir(&self.root)?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
            .collect::<Vec<_>>();
        files.sort();
        Ok(files)
    }

    fn prune_for_new_session(&self) -> Result<(), JournalError> {
        let files = self.session_files()?;
        let keep_before_new = self.max_session_files.saturating_sub(1);
        let remove_count = files.len().saturating_sub(keep_before_new);
        for path in files.into_iter().take(remove_count) {
            fs::remove_file(path)?;
        }
        Ok(())
    }
}

#[derive(Debug)]
struct WriterState {
    writer: BufWriter<File>,
    ended: bool,
}

#[derive(Debug)]
pub struct SessionJournal {
    session_id: String,
    path: PathBuf,
    state: Mutex<WriterState>,
}

impl SessionJournal {
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn record(
        &self,
        source: EventSource,
        kind: EventKind,
        confidence: EventConfidence,
        metadata: BTreeMap<String, Value>,
    ) -> Result<SessionEvent, JournalError> {
        let mut state = self.lock_state()?;
        if state.ended {
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "cannot append to a finished VSleep session journal",
            )
            .into());
        }
        let event = SessionEvent::new(self.session_id.clone(), source, kind, confidence)
            .with_metadata(metadata);
        Self::append_event(&mut state, &event)?;
        Ok(event)
    }

    pub fn finish(&self) -> Result<Option<SessionEvent>, JournalError> {
        let mut state = self.lock_state()?;
        if state.ended {
            return Ok(None);
        }
        let event = SessionEvent::new(
            self.session_id.clone(),
            EventSource::Vsleep,
            EventKind::SessionEnded,
            EventConfidence::Observed,
        );
        Self::append_event(&mut state, &event)?;
        state.ended = true;
        Ok(Some(event))
    }

    fn lock_state(&self) -> Result<std::sync::MutexGuard<'_, WriterState>, JournalError> {
        self.state.lock().map_err(|error| {
            std::io::Error::other(format!("session journal writer lock poisoned: {error}")).into()
        })
    }

    fn append_event(state: &mut WriterState, event: &SessionEvent) -> Result<(), JournalError> {
        let mut bytes = serde_json::to_vec(event)?;
        bytes.push(b'\n');
        state.writer.write_all(&bytes)?;
        state.writer.flush()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_append_only_session_events() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionJournalStore::new(directory.path().to_path_buf()).unwrap();
        let journal = store.start_session().unwrap();

        let mut metadata = BTreeMap::new();
        metadata.insert("device_index".to_string(), Value::from(0));
        journal
            .record(
                EventSource::OpenVr,
                EventKind::HmdDisconnected,
                EventConfidence::Observed,
                metadata,
            )
            .unwrap();
        journal.finish().unwrap();

        let events = store.read_session(journal.path()).unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].kind, EventKind::SessionStarted);
        assert_eq!(events[1].kind, EventKind::HmdDisconnected);
        assert_eq!(events[1].metadata["device_index"], Value::from(0));
        assert_eq!(events[2].kind, EventKind::SessionEnded);
        assert!(events
            .iter()
            .all(|event| event.session_id == journal.session_id()));
    }

    #[test]
    fn prevents_writes_after_session_finish() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionJournalStore::new(directory.path().to_path_buf()).unwrap();
        let journal = store.start_session().unwrap();
        journal.finish().unwrap();

        let result = journal.record(
            EventSource::SleepMode,
            EventKind::SleepModeEnabled,
            EventConfidence::Observed,
            BTreeMap::new(),
        );
        assert!(matches!(result, Err(JournalError::Io(_))));
        assert!(journal.finish().unwrap().is_none());
    }

    #[test]
    fn bounds_retained_session_files() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionJournalStore::with_retention(directory.path().to_path_buf(), 2).unwrap();

        for _ in 0..3 {
            let journal = store.start_session().unwrap();
            journal.finish().unwrap();
        }

        assert_eq!(store.session_files().unwrap().len(), 2);
    }
}
