pub mod commands;
mod event;
mod health;
mod journal;
mod observer;
mod runtime;
mod timeline;

#[cfg(test)]
mod reliability_contract_tests;

use std::{path::PathBuf, sync::LazyLock};
use tokio::sync::Mutex;

pub use event::{EventConfidence, EventKind, EventSource, SessionEvent};
pub use health::{current_health_snapshot, RuntimeHealthSnapshot, HEALTH_EVENT_NAME};
pub use journal::{
    JournalError, SessionFileInfo, SessionJournal, SessionJournalStore, DEFAULT_MAX_SESSION_FILES,
};
pub use observer::{observe_hmd_connected, observe_steamvr_process, observe_vrchat_process};
pub use runtime::{RuntimeError, SessionJournalRuntime};
pub use timeline::{
    build_session_report, FailureClass, FailureClassification, RuntimeUptimeSummary, SessionReport,
    SessionUptimeSummary,
};

pub static INSTANCE: LazyLock<Mutex<Option<SessionJournalRuntime>>> = LazyLock::new(Default::default);

pub async fn init(root: PathBuf) -> Result<(), RuntimeError> {
    let runtime = SessionJournalRuntime::new(root)?;
    *INSTANCE.lock().await = Some(runtime);
    observer::start_observers();
    health::start_health_publisher();
    Ok(())
}
