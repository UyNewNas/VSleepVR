use super::{EventConfidence, EventKind, EventSource, RuntimeError, SessionEvent, INSTANCE};
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

            let Some(session_id) = active_session_id().await else {
                clear_hmd_connection_cache().await;
                continue;
            };

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
            if let Err(error) = observe_hmd_connected_for_session(&session_id, connected).await {
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

            let Some(session_id) = active_session_id().await else {
                clear_steamvr_process_cache().await;
                continue;
            };

            let process_ids = crate::utils::process_ids("vrmonitor.exe").await;
            let process_count = process_ids.len();
            if let Err(error) = observe_steamvr_process_for_session(&session_id, process_count).await {
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

            let Some(session_id) = active_session_id().await else {
                clear_vrchat_process_cache().await;
                continue;
            };

            let process_ids = crate::utils::process_ids("VRChat.exe").await;
            let process_count = process_ids.len();
            if let Err(error) = observe_vrchat_process_for_session(&session_id, process_count).await {
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
    let Some(session_id) = active_session_id().await else {
        clear_hmd_connection_cache().await;
        return Ok(None);
    };
    observe_hmd_connected_for_session(&session_id, connected).await
}

async fn observe_hmd_connected_for_session(
    expected_session_id: &str,
    connected: bool,
) -> Result<Option<SessionEvent>, RuntimeError> {
    let instance = INSTANCE.lock().await;
    let Some(runtime) = instance.as_ref() else {
        clear_hmd_connection_cache().await;
        return Ok(None);
    };
    if !matches_expected_session(expected_session_id, runtime.active_session_id()) {
        return Ok(None);
    }

    let mut previous = LAST_HMD_CONNECTION.lock().await;
    if same_hmd_observation(previous.as_ref(), expected_session_id, connected) {
        return Ok(None);
    }

    let kind = if connected {
        EventKind::HmdConnected
    } else {
        EventKind::HmdDisconnected
    };
    let event = runtime.record_if_active_session(
        expected_session_id,
        EventSource::OpenVr,
        kind,
        EventConfidence::Observed,
        BTreeMap::new(),
    )?;

    if event.is_some() {
        *previous = Some(HmdConnectionObservation {
            session_id: expected_session_id.to_string(),
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
    let Some(session_id) = active_session_id().await else {
        clear_steamvr_process_cache().await;
        return Ok(None);
    };
    observe_steamvr_process_for_session(&session_id, process_count).await
}

async fn observe_steamvr_process_for_session(
    expected_session_id: &str,
    process_count: usize,
) -> Result<Option<SessionEvent>, RuntimeError> {
    let instance = INSTANCE.lock().await;
    let Some(runtime) = instance.as_ref() else {
        clear_steamvr_process_cache().await;
        return Ok(None);
    };
    if !matches_expected_session(expected_session_id, runtime.active_session_id()) {
        return Ok(None);
    }

    let running = process_count > 0;
    let mut previous = LAST_STEAMVR_PROCESS.lock().await;
    if same_process_observation(previous.as_ref(), expected_session_id, running) {
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
    let event = runtime.record_if_active_session(
        expected_session_id,
        EventSource::SteamVr,
        kind,
        EventConfidence::Observed,
        metadata,
    )?;

    if event.is_some() {
        *previous = Some(ProcessObservation {
            session_id: expected_session_id.to_string(),
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
    let Some(session_id) = active_session_id().await else {
        clear_vrchat_process_cache().await;
        return Ok(None);
    };
    observe_vrchat_process_for_session(&session_id, process_count).await
}

async fn observe_vrchat_process_for_session(
    expected_session_id: &str,
    process_count: usize,
) -> Result<Option<SessionEvent>, RuntimeError> {
    let instance = INSTANCE.lock().await;
    let Some(runtime) = instance.as_ref() else {
        clear_vrchat_process_cache().await;
        return Ok(None);
    };
    if !matches_expected_session(expected_session_id, runtime.active_session_id()) {
        return Ok(None);
    }

    let running = process_count > 0;
    let mut previous = LAST_VRCHAT_PROCESS.lock().await;
    if same_process_observation(previous.as_ref(), expected_session_id, running) {
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
    let event = runtime.record_if_active_session(
        expected_session_id,
        EventSource::VrchatProcess,
        kind,
        EventConfidence::Observed,
        metadata,
    )?;

    if event.is_some() {
        *previous = Some(ProcessObservation {
            session_id: expected_session_id.to_string(),
            running,
        });
    }
    Ok(event)
}

async fn active_session_id() -> Option<String> {
    INSTANCE
        .lock()
        .await
        .as_ref()
        .and_then(|runtime| runtime.active_session_id().map(str::to_string))
}

fn matches_expected_session(expected_session_id: &str, active_session_id: Option<&str>) -> bool {
    active_session_id == Some(expected_session_id)
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
    fn samples_are_attributed_only_to_the_session_that_started_sampling() {
        assert!(matches_expected_session("session-a", Some("session-a")));
        assert!(!matches_expected_session("session-a", Some("session-b")));
        assert!(!matches_expected_session("session-a", None));
    }
}
