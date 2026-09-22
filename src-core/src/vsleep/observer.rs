use super::{
    timeline::is_authoritative_reliability_observation, EventConfidence, EventKind, EventSource,
    RuntimeError, SessionEvent, SessionJournalRuntime, INSTANCE,
};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        LazyLock,
    },
    time::Duration,
};
use tokio::sync::Mutex;

const HMD_OBSERVER_INTERVAL: Duration = Duration::from_millis(250);
const STEAMVR_PROCESS_OBSERVER_INTERVAL: Duration = Duration::from_secs(1);
const VRCHAT_PROCESS_OBSERVER_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, PartialEq, Eq)]
struct HmdConnectionObservation {
    session_id: String,
    connected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProcessObservation {
    session_id: String,
    running: bool,
}

static HMD_OBSERVER_STARTED: AtomicBool = AtomicBool::new(false);
static STEAMVR_PROCESS_OBSERVER_STARTED: AtomicBool = AtomicBool::new(false);
static VRCHAT_PROCESS_OBSERVER_STARTED: AtomicBool = AtomicBool::new(false);
static LAST_HMD_CONNECTION: LazyLock<Mutex<Option<HmdConnectionObservation>>> =
    LazyLock::new(Default::default);
static LAST_STEAMVR_PROCESS: LazyLock<Mutex<Option<ProcessObservation>>> =
    LazyLock::new(Default::default);
static LAST_VRCHAT_PROCESS: LazyLock<Mutex<Option<ProcessObservation>>> =
    LazyLock::new(Default::default);

/// Starts all passive VSleep runtime observers.
///
/// These tasks are deliberately observation-only: they record facts while a VSleep session is
/// active and never restart, reconnect, or otherwise mutate SteamVR, VRChat, or the HMD runtime.
pub fn start_observers() {
    start_openvr_hmd_observer();
    start_steamvr_process_observer();
    start_vrchat_process_observer();
}

/// Starts a passive OpenVR HMD connectivity sampler.
///
/// The task only samples while a VSleep session is active. An unavailable OpenVR context is
/// treated as "no observation" rather than "disconnected", because runtime unavailability does
/// not prove that the physical/link layer disconnected. This keeps the journal observation-first
/// and avoids manufacturing HMD failures from ambiguous evidence.
fn start_openvr_hmd_observer() {
    if HMD_OBSERVER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    tokio::spawn(async {
        loop {
            tokio::time::sleep(HMD_OBSERVER_INTERVAL).await;

            if !has_active_session().await {
                clear_hmd_connection_cache().await;
                continue;
            }

            let connected = {
                let context = crate::openvr::OVR_CONTEXT.lock().await;
                let Some(context) = context.as_ref() else {
                    continue;
                };
                context
                    .system()
                    .get_device_to_absolute_tracking_pose(
                        raphii_openvr_rs::raw::ETrackingUniverseOrigin::TrackingUniverseStanding,
                        0.0,
                    )
                    .ok()
                    .and_then(|poses| poses.first().map(|pose| pose.bDeviceIsConnected))
            };

            let Some(connected) = connected else {
                continue;
            };
            if let Err(error) = observe_hmd_connected(connected).await {
                log::error!("[VSleep] Failed to record HMD connectivity observation: {error}");
            }
        }
    });
}

/// Starts a passive SteamVR process sampler using the same `vrmonitor.exe` signal already used
/// by the upstream OpenVR module to decide whether SteamVR is running.
///
/// A baseline is written for every VSleep session, followed only by start/stop transitions. This
/// observes process presence only; it does not infer why SteamVR stopped or mutate the runtime.
fn start_steamvr_process_observer() {
    if STEAMVR_PROCESS_OBSERVER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    tokio::spawn(async {
        loop {
            tokio::time::sleep(STEAMVR_PROCESS_OBSERVER_INTERVAL).await;

            if !has_active_session().await {
                clear_steamvr_process_cache().await;
                continue;
            }

            let process_ids = crate::utils::process_ids("vrmonitor.exe").await;
            let process_count = process_ids.len();
            if let Err(error) = observe_steamvr_process(process_count).await {
                log::error!("[VSleep] Failed to record SteamVR process observation: {error}");
            }
        }
    });
}

/// Starts a passive VRChat process sampler using the process cache already maintained by the
/// upstream utility module.
///
/// A baseline is written for every VSleep session, followed only by start/stop transitions. The
/// event metadata contains the observed process count, but no process IDs or account/session data.
fn start_vrchat_process_observer() {
    if VRCHAT_PROCESS_OBSERVER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    tokio::spawn(async {
        loop {
            tokio::time::sleep(VRCHAT_PROCESS_OBSERVER_INTERVAL).await;

            if !has_active_session().await {
                clear_vrchat_process_cache().await;
                continue;
            }

            let process_ids = crate::utils::process_ids("VRChat.exe").await;
            let process_count = process_ids.len();
            if let Err(error) = observe_vrchat_process(process_count).await {
                log::error!("[VSleep] Failed to record VRChat process observation: {error}");
            }
        }
    });
}

/// Records the first OpenVR HMD connectivity sample for each VSleep session and every
/// subsequent transition. Repeated samples are ignored so the journal remains transition-based.
///
/// When no VSleep session is active, the cached observation is cleared. This guarantees that a
/// newly started session receives a baseline HMD connectivity event even if the physical state
/// has not changed since the previous session.
pub async fn observe_hmd_connected(connected: bool) -> Result<Option<SessionEvent>, RuntimeError> {
    let instance = INSTANCE.lock().await;
    let Some(runtime) = instance.as_ref() else {
        clear_hmd_connection_cache().await;
        return Ok(None);
    };
    let Some(session_id) = runtime.active_session_id().map(str::to_string) else {
        clear_hmd_connection_cache().await;
        return Ok(None);
    };

    let mut previous = LAST_HMD_CONNECTION.lock().await;
    if same_hmd_observation(previous.as_ref(), &session_id, connected) {
        return Ok(None);
    }

    let kind = if connected {
        EventKind::HmdConnected
    } else {
        EventKind::HmdDisconnected
    };
    let event = record_authoritative_observation(
        runtime,
        EventSource::OpenVr,
        kind,
        BTreeMap::new(),
    )?;

    if event.is_some() {
        *previous = Some(HmdConnectionObservation {
            session_id,
            connected,
        });
    }
    Ok(event)
}

/// Records a per-session SteamVR process baseline and subsequent running/stopped transitions.
///
/// `process_count` is observed from the upstream sysinfo process cache using `vrmonitor.exe`,
/// which upstream already treats as its SteamVR-running gate. Only the count is persisted.
pub async fn observe_steamvr_process(
    process_count: usize,
) -> Result<Option<SessionEvent>, RuntimeError> {
    let instance = INSTANCE.lock().await;
    let Some(runtime) = instance.as_ref() else {
        clear_steamvr_process_cache().await;
        return Ok(None);
    };
    let Some(session_id) = runtime.active_session_id().map(str::to_string) else {
        clear_steamvr_process_cache().await;
        return Ok(None);
    };

    let running = process_count > 0;
    let mut previous = LAST_STEAMVR_PROCESS.lock().await;
    if same_process_observation(previous.as_ref(), &session_id, running) {
        return Ok(None);
    }

    let kind = if running {
        EventKind::SteamVrStarted
    } else {
        EventKind::SteamVrStopped
    };
    let mut metadata = BTreeMap::new();
    metadata.insert(
        "process_count".to_string(),
        serde_json::Value::from(process_count as u64),
    );
    let event = record_authoritative_observation(runtime, EventSource::SteamVr, kind, metadata)?;

    if event.is_some() {
        *previous = Some(ProcessObservation {
            session_id,
            running,
        });
    }
    Ok(event)
}

/// Records a per-session VRChat process baseline and subsequent running/stopped transitions.
///
/// `process_count` is observed from the upstream sysinfo process cache. Only the count is stored
/// in metadata; process IDs are intentionally omitted because they add little diagnostic value
/// after the fact and are unnecessarily volatile.
pub async fn observe_vrchat_process(
    process_count: usize,
) -> Result<Option<SessionEvent>, RuntimeError> {
    let instance = INSTANCE.lock().await;
    let Some(runtime) = instance.as_ref() else {
        clear_vrchat_process_cache().await;
        return Ok(None);
    };
    let Some(session_id) = runtime.active_session_id().map(str::to_string) else {
        clear_vrchat_process_cache().await;
        return Ok(None);
    };

    let running = process_count > 0;
    let mut previous = LAST_VRCHAT_PROCESS.lock().await;
    if same_process_observation(previous.as_ref(), &session_id, running) {
        return Ok(None);
    }

    let kind = if running {
        EventKind::VrchatStarted
    } else {
        EventKind::VrchatStopped
    };
    let mut metadata = BTreeMap::new();
    metadata.insert(
        "process_count".to_string(),
        serde_json::Value::from(process_count as u64),
    );
    let event =
        record_authoritative_observation(runtime, EventSource::VrchatProcess, kind, metadata)?;

    if event.is_some() {
        *previous = Some(ProcessObservation {
            session_id,
            running,
        });
    }
    Ok(event)
}

/// Writes a reliability-authoritative observer row only when its source/kind pair is part of the
/// shared evidence contract. The generic journal API remains permissive so forensic or inferred
/// rows can still be retained, but the production observer path fails closed before persistence
/// if a future edit accidentally mismatches an observed producer and event kind.
fn record_authoritative_observation(
    runtime: &SessionJournalRuntime,
    source: EventSource,
    kind: EventKind,
    metadata: BTreeMap<String, serde_json::Value>,
) -> Result<Option<SessionEvent>, RuntimeError> {
    let Some(session_id) = runtime.active_session_id() else {
        return Ok(None);
    };

    let candidate = SessionEvent::new(session_id, source, kind, EventConfidence::Observed);
    if !is_authoritative_reliability_observation(&candidate) {
        log::error!(
            "[VSleep] Refusing non-authoritative observed reliability row: source={source:?}, kind={kind:?}"
        );
        return Ok(None);
    }

    runtime.record_if_active(
        source,
        kind,
        EventConfidence::Observed,
        metadata,
    )
}

async fn has_active_session() -> bool {
    INSTANCE
        .lock()
        .await
        .as_ref()
        .and_then(|runtime| runtime.active_session_id())
        .is_some()
}

fn same_hmd_observation(
    previous: Option<&HmdConnectionObservation>,
    session_id: &str,
    connected: bool,
) -> bool {
    previous.is_some_and(|value| value.session_id == session_id && value.connected == connected)
}

fn same_process_observation(
    previous: Option<&ProcessObservation>,
    session_id: &str,
    running: bool,
) -> bool {
    previous.is_some_and(|value| value.session_id == session_id && value.running == running)
}

async fn clear_hmd_connection_cache() {
    *LAST_HMD_CONNECTION.lock().await = None;
}

async fn clear_steamvr_process_cache() {
    *LAST_STEAMVR_PROCESS.lock().await = None;
}

async fn clear_vrchat_process_cache() {
    *LAST_VRCHAT_PROCESS.lock().await = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_hmd_observations_are_deduplicated_within_a_session() {
        let previous = HmdConnectionObservation {
            session_id: "session-a".to_string(),
            connected: true,
        };

        assert!(same_hmd_observation(Some(&previous), "session-a", true));
        assert!(!same_hmd_observation(Some(&previous), "session-a", false));
        assert!(!same_hmd_observation(Some(&previous), "session-b", true));
        assert!(!same_hmd_observation(None, "session-a", true));
    }

    #[test]
    fn identical_process_observations_are_deduplicated_within_a_session() {
        let previous = ProcessObservation {
            session_id: "session-a".to_string(),
            running: true,
        };

        assert!(same_process_observation(Some(&previous), "session-a", true));
        assert!(!same_process_observation(Some(&previous), "session-a", false));
        assert!(!same_process_observation(Some(&previous), "session-b", true));
        assert!(!same_process_observation(None, "session-a", true));
    }

    #[test]
    fn production_observer_guard_rejects_non_authoritative_observed_rows_before_persistence() {
        let directory = tempfile::tempdir().unwrap();
        let mut runtime = SessionJournalRuntime::new(directory.path().to_path_buf()).unwrap();
        runtime.start_session().unwrap();

        let rejected = record_authoritative_observation(
            &runtime,
            EventSource::VrchatLog,
            EventKind::SteamVrStarted,
            BTreeMap::new(),
        )
        .unwrap();
        assert!(rejected.is_none());

        runtime.finish_session().unwrap();
        let sessions = runtime.list_sessions().unwrap();
        let events = runtime.read_session(&sessions[0].file_name).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, EventKind::SessionStarted);
        assert_eq!(events[1].kind, EventKind::SessionEnded);
    }
}
