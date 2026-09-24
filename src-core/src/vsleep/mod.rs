pub mod commands;
mod event;
mod journal;
mod runtime;

use std::{path::PathBuf, sync::LazyLock};
use tokio::sync::Mutex;

pub use event::{EventConfidence, EventKind, EventSource, SessionEvent};
pub use journal::{
    JournalError, SessionFileInfo, SessionJournal, SessionJournalStore, DEFAULT_MAX_SESSION_FILES,
};
pub use runtime::{RuntimeError, SessionJournalRuntime};

pub static INSTANCE: LazyLock<Mutex<Option<SessionJournalRuntime>>> = LazyLock::new(Default::default);

pub async fn init(root: PathBuf) -> Result<(), RuntimeError> {
    let runtime = SessionJournalRuntime::new(root)?;
    *INSTANCE.lock().await = Some(runtime);
    Ok(())
}
