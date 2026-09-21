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

#[derive(Debug, Clone, PartialEq, Eq)]
struct HmdConnectionObservation {
    session_id: String,
    connected: bool,
}

static OBSERVER_STARTED: AtomicBool = AtomicBool::new(false);
static LAST_HMD_CONNECTION: LazyLock<Mutex<Option<HmdConnectionObservation>>> =
    LazyLock::new(Default::default);

/// Starts a passive OpenVR HMD connectivity sampler.
///
/// The task only samples while a VSleep session is active. An unavailable OpenVR context is
/// treated as "no observation" rather than "disconnected", because runtime unavailability does
/// not prove that the physical/link layer disconnected. This keeps the journal observation-first
/// and avoids manufacturing HMD failures from ambiguous evidence.
pub fn start_openvr_hmd_observer() {
    if OBSERVER_STARTED.swap(true, Ordering::SeqCst) {
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
    if same_observation(previous.as_ref(), &session_id, connected) {
        return Ok(None);
    }

    let kind = if connected {
        EventKind::HmdConnected
    } else {
        EventKind::HmdDisconnected
    };
    let event = runtime.record_if_active(
        EventSource::OpenVr,
        kind,
        EventConfidence::Observed,
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

async fn has_active_session() -> bool {
    INSTANCE
        .lock()
        .await
        .as_ref()
        .and_then(|runtime| runtime.active_session_id())
        .is_some()
}

fn same_observation(
    previous: Option<&HmdConnectionObservation>,
    session_id: &str,
    connected: bool,
) -> bool {
    previous.is_some_and(|value| value.session_id == session_id && value.connected == connected)
}

async fn clear_hmd_connection_cache() {
    *LAST_HMD_CONNECTION.lock().await = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_observations_are_deduplicated_within_a_session() {
        let previous = HmdConnectionObservation {
            session_id: "session-a".to_string(),
            connected: true,
        };

        assert!(same_observation(Some(&previous), "session-a", true));
        assert!(!same_observation(Some(&previous), "session-a", false));
        assert!(!same_observation(Some(&previous), "session-b", true));
        assert!(!same_observation(None, "session-a", true));
    }
}
