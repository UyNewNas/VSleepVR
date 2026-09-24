use super::{
    observe_hmd_connected, observe_steamvr_process, observe_vrchat_process,
    timeline::is_authoritative_reliability_observation, EventConfidence, EventKind, EventSource,
    SessionJournalRuntime, INSTANCE,
};
use std::sync::LazyLock;
use tokio::sync::Mutex;

static PRODUCER_CONTRACT_TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(Default::default);

#[tokio::test]
async fn observe_only_producers_emit_only_authoritative_observed_pairs() {
    let _test_guard = PRODUCER_CONTRACT_TEST_LOCK.lock().await;

    // Reset the singleton and each observer's per-session cache before the fixture starts.
    // Calling the public observer entry points without an active runtime clears those caches
    // without writing any journal rows.
    *INSTANCE.lock().await = None;
    assert!(observe_hmd_connected(true).await.unwrap().is_none());
    assert!(observe_steamvr_process(1).await.unwrap().is_none());
    assert!(observe_vrchat_process(1).await.unwrap().is_none());

    let directory = tempfile::tempdir().unwrap();
    {
        let mut instance = INSTANCE.lock().await;
        let mut runtime = SessionJournalRuntime::new(directory.path().to_path_buf()).unwrap();
        runtime.start_session().unwrap();
        *instance = Some(runtime);
    }

    let emitted = vec![
        observe_hmd_connected(true).await.unwrap().unwrap(),
        observe_hmd_connected(false).await.unwrap().unwrap(),
        observe_steamvr_process(1).await.unwrap().unwrap(),
        observe_steamvr_process(0).await.unwrap().unwrap(),
        observe_vrchat_process(1).await.unwrap().unwrap(),
        observe_vrchat_process(0).await.unwrap().unwrap(),
    ];

    let actual_pairs: Vec<_> = emitted
        .iter()
        .map(|event| (event.source, event.kind, event.confidence))
        .collect();
    assert_eq!(
        actual_pairs,
        vec![
            (
                EventSource::OpenVr,
                EventKind::HmdConnected,
                EventConfidence::Observed,
            ),
            (
                EventSource::OpenVr,
                EventKind::HmdDisconnected,
                EventConfidence::Observed,
            ),
            (
                EventSource::SteamVr,
                EventKind::SteamVrStarted,
                EventConfidence::Observed,
            ),
            (
                EventSource::SteamVr,
                EventKind::SteamVrStopped,
                EventConfidence::Observed,
            ),
            (
                EventSource::VrchatProcess,
                EventKind::VrchatStarted,
                EventConfidence::Observed,
            ),
            (
                EventSource::VrchatProcess,
                EventKind::VrchatStopped,
                EventConfidence::Observed,
            ),
        ]
    );
    assert!(emitted
        .iter()
        .all(is_authoritative_reliability_observation));

    let persisted = {
        let mut instance = INSTANCE.lock().await;
        let runtime = instance.as_mut().unwrap();
        runtime.finish_session().unwrap();
        let sessions = runtime.list_sessions().unwrap();
        runtime.read_session(&sessions[0].file_name).unwrap()
    };

    // The journal contains the two VSleep session boundaries plus exactly the six
    // authoritative observer rows above. This catches source/kind drift in the real
    // producer functions instead of only testing the classifier's acceptance table.
    assert_eq!(persisted.len(), 8);
    assert!(persisted
        .iter()
        .all(is_authoritative_reliability_observation));

    *INSTANCE.lock().await = None;
}
