use super::{EventConfidence, EventKind, EventSource, RuntimeError, SessionEvent, INSTANCE};
use std::{collections::BTreeMap, sync::LazyLock};
use tokio::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq)]
struct HmdConnectionObservation {
    session_id: String,
    connected: bool,
}

static LAST_HMD_CONNECTION: LazyLock<Mutex<Option<HmdConnectionObservation>>> =
    LazyLock::new(Default::default);

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
    if previous
        .as_ref()
        .is_some_and(|value| value.session_id == session_id && value.connected == connected)
    {
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

async fn clear_hmd_connection_cache() {
    *LAST_HMD_CONNECTION.lock().await = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_observations_are_session_scoped() {
        let previous = HmdConnectionObservation {
            session_id: "session-a".to_string(),
            connected: true,
        };

        assert!(previous.session_id == "session-a" && previous.connected);
        assert!(!(previous.session_id == "session-b" && previous.connected));
        assert!(!(previous.session_id == "session-a" && !previous.connected));
    }
}
