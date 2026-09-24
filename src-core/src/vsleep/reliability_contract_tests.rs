use super::{
    timeline::is_authoritative_reliability_observation, EventConfidence, EventKind, EventSource,
    SessionEvent,
};

macro_rules! define_sources {
    ($($source:ident),+ $(,)?) => {
        const ALL_SOURCES: &[EventSource] = &[$(EventSource::$source),+];

        fn source_is_declared(source: EventSource) -> bool {
            match source {
                $(EventSource::$source => true,)+
            }
        }
    };
}

define_sources!(
    Vsleep,
    OpenVr,
    SteamVr,
    VrchatProcess,
    VrchatLog,
    WindowsPower,
    SleepMode,
);

macro_rules! define_confidences {
    ($($confidence:ident),+ $(,)?) => {
        const ALL_CONFIDENCES: &[EventConfidence] = &[$(EventConfidence::$confidence),+];

        fn confidence_is_declared(confidence: EventConfidence) -> bool {
            match confidence {
                $(EventConfidence::$confidence => true,)+
            }
        }
    };
}

define_confidences!(Observed, InferredHigh, InferredMedium, InferredLow);

macro_rules! define_authority_contract {
    ($($kind:ident => $source:ident),+ $(,)?) => {
        const ALL_KINDS: &[EventKind] = &[$(EventKind::$kind),+];

        fn authoritative_source_for(kind: EventKind) -> EventSource {
            match kind {
                $(EventKind::$kind => EventSource::$source,)+
            }
        }
    };
}

define_authority_contract!(
    SessionStarted => Vsleep,
    SessionEnded => Vsleep,
    HmdConnected => OpenVr,
    HmdDisconnected => OpenVr,
    SteamVrStarted => SteamVr,
    SteamVrStopped => SteamVr,
    SteamVrStandbyEntered => SteamVr,
    SteamVrStandbyExited => SteamVr,
    VrchatStarted => VrchatProcess,
    VrchatStopped => VrchatProcess,
    WindowsSuspend => WindowsPower,
    WindowsResume => WindowsPower,
    WindowsPowerEvent => WindowsPower,
    SleepModeEnabled => SleepMode,
    SleepModeDisabled => SleepMode,
);

#[test]
fn reliability_authority_contract_is_exhaustive_and_fail_closed() {
    let mut accepted_observed_pairs = 0;

    for &confidence in ALL_CONFIDENCES {
        assert!(confidence_is_declared(confidence));

        for &source in ALL_SOURCES {
            assert!(source_is_declared(source));

            for &kind in ALL_KINDS {
                let event = SessionEvent::new("contract-session", source, kind, confidence);
                let expected = confidence == EventConfidence::Observed
                    && source == authoritative_source_for(kind);
                let actual = is_authoritative_reliability_observation(&event);

                assert_eq!(
                    actual, expected,
                    "unexpected reliability authority decision for confidence={confidence:?}, source={source:?}, kind={kind:?}"
                );

                if actual {
                    accepted_observed_pairs += 1;
                }
            }
        }
    }

    assert_eq!(
        accepted_observed_pairs,
        ALL_KINDS.len(),
        "each normalized reliability event kind must have exactly one authoritative observed source"
    );
}
