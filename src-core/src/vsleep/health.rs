use super::INSTANCE;
use serde::Serialize;
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

const HEALTH_PUBLISH_INTERVAL: Duration = Duration::from_secs(1);
pub const HEALTH_EVENT_NAME: &str = "VSLEEP_HEALTH_SNAPSHOT";

static HEALTH_PUBLISHER_STARTED: AtomicBool = AtomicBool::new(false);

/// Correlated, observation-only VSleep runtime state published to the frontend.
///
/// `None` means that a fact is currently unavailable or not applicable. In particular, an
/// unavailable OpenVR context is never converted into `hmd_connected = false` because that would
/// turn ambiguous runtime evidence into a fabricated physical/link-layer disconnect.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHealthSnapshot {
    pub session_id: Option<String>,
    pub observed_at_ms: u64,
    pub hmd_connected: Option<bool>,
    pub steamvr_running: Option<bool>,
    pub vrchat_running: Option<bool>,
}

pub fn start_health_publisher() {
    if HEALTH_PUBLISHER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    tokio::spawn(async {
        loop {
            tokio::time::sleep(HEALTH_PUBLISH_INTERVAL).await;
            let snapshot = current_health_snapshot().await;
            crate::utils::send_event(HEALTH_EVENT_NAME, snapshot).await;
        }
    });
}

pub async fn current_health_snapshot() -> RuntimeHealthSnapshot {
    let Some(session_id) = active_session_id().await else {
        return unknown_health_snapshot(None, crate::utils::get_time() as u64);
    };

    let hmd_connected = sample_hmd_connected().await;
    let steamvr_running = !crate::utils::process_ids("vrmonitor.exe").await.is_empty();
    let vrchat_running = !crate::utils::process_ids("VRChat.exe").await.is_empty();
    let current_session_id = active_session_id().await;

    finalize_sampled_snapshot(
        session_id,
        current_session_id,
        crate::utils::get_time() as u64,
        hmd_connected,
        steamvr_running,
        vrchat_running,
    )
}

async fn active_session_id() -> Option<String> {
    INSTANCE
        .lock()
        .await
        .as_ref()
        .and_then(|runtime| runtime.active_session_id().map(str::to_string))
}

fn finalize_sampled_snapshot(
    expected_session_id: String,
    current_session_id: Option<String>,
    observed_at_ms: u64,
    hmd_connected: Option<bool>,
    steamvr_running: bool,
    vrchat_running: bool,
) -> RuntimeHealthSnapshot {
    if current_session_id.as_deref() != Some(expected_session_id.as_str()) {
        // Sampling crosses multiple async boundaries. If the active session changed while those
        // facts were collected, they cannot safely be attributed to either session. Preserve the
        // current session identity for the UI but quarantine all sampled facts until the next tick.
        return unknown_health_snapshot(current_session_id, observed_at_ms);
    }

    RuntimeHealthSnapshot {
        session_id: Some(expected_session_id),
        observed_at_ms,
        hmd_connected,
        steamvr_running: Some(steamvr_running),
        vrchat_running: Some(vrchat_running),
    }
}

fn unknown_health_snapshot(
    session_id: Option<String>,
    observed_at_ms: u64,
) -> RuntimeHealthSnapshot {
    RuntimeHealthSnapshot {
        session_id,
        observed_at_ms,
        hmd_connected: None,
        steamvr_running: None,
        vrchat_running: None,
    }
}

async fn sample_hmd_connected() -> Option<bool> {
    let context = crate::openvr::OVR_CONTEXT.lock().await;
    let context = context.as_ref()?;
    context
        .system()
        .get_device_to_absolute_tracking_pose(
            raphii_openvr_rs::raw::ETrackingUniverseOrigin::TrackingUniverseStanding,
            0.0,
        )
        .ok()
        .and_then(|poses| poses.first().map(|pose| pose.bDeviceIsConnected))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inactive_snapshot_keeps_runtime_facts_unknown() {
        let snapshot = unknown_health_snapshot(None, 123);

        assert!(snapshot.session_id.is_none());
        assert_eq!(snapshot.hmd_connected, None);
        assert_eq!(snapshot.steamvr_running, None);
        assert_eq!(snapshot.vrchat_running, None);
    }

    #[test]
    fn active_snapshot_can_preserve_unknown_hmd_without_hiding_process_facts() {
        let snapshot = finalize_sampled_snapshot(
            "session-a".to_string(),
            Some("session-a".to_string()),
            123,
            None,
            true,
            false,
        );

        assert_eq!(snapshot.session_id.as_deref(), Some("session-a"));
        assert_eq!(snapshot.hmd_connected, None);
        assert_eq!(snapshot.steamvr_running, Some(true));
        assert_eq!(snapshot.vrchat_running, Some(false));
    }

    #[test]
    fn session_rotation_quarantines_facts_sampled_for_the_previous_session() {
        let snapshot = finalize_sampled_snapshot(
            "session-a".to_string(),
            Some("session-b".to_string()),
            123,
            Some(true),
            true,
            true,
        );

        assert_eq!(snapshot.session_id.as_deref(), Some("session-b"));
        assert_eq!(snapshot.hmd_connected, None);
        assert_eq!(snapshot.steamvr_running, None);
        assert_eq!(snapshot.vrchat_running, None);
    }

    #[test]
    fn session_end_quarantines_facts_sampled_for_the_finished_session() {
        let snapshot = finalize_sampled_snapshot(
            "session-a".to_string(),
            None,
            123,
            Some(false),
            false,
            true,
        );

        assert!(snapshot.session_id.is_none());
        assert_eq!(snapshot.hmd_connected, None);
        assert_eq!(snapshot.steamvr_running, None);
        assert_eq!(snapshot.vrchat_running, None);
    }
}
