use super::event::{EventConfidence, EventKind, SessionEvent};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureClass {
    HmdOrLinkFailure,
    SteamVrFailure,
    VrchatFailure,
    WindowsPowerTransition,
    UnknownInsufficientEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FailureClassification {
    pub timestamp_utc: String,
    pub category: FailureClass,
    pub confidence: EventConfidence,
    pub evidence: Vec<EventKind>,
    pub rationale: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionReport {
    pub session_id: Option<String>,
    pub observations: Vec<SessionEvent>,
    pub classifications: Vec<FailureClassification>,
}

pub fn build_session_report(events: &[SessionEvent]) -> SessionReport {
    let mut steamvr_running = None;
    let mut vrchat_running = None;
    let mut classifications = Vec::new();

    for event in events {
        match event.kind {
            EventKind::SteamVrStarted => steamvr_running = Some(true),
            EventKind::SteamVrStopped => {
                classifications.push(if vrchat_running == Some(true) {
                    classify(
                        event,
                        FailureClass::SteamVrFailure,
                        EventConfidence::InferredMedium,
                        vec![EventKind::SteamVrStopped, EventKind::VrchatStarted],
                        "SteamVR stopped while VRChat was last observed running. The stop is real, but its cause is not yet known.",
                    )
                } else {
                    unknown(
                        event,
                        "SteamVR stopped without a correlated live VRChat observation, so a runtime failure cannot be distinguished from an intentional stop or a broader shutdown.",
                    )
                });
                steamvr_running = Some(false);
            }
            EventKind::VrchatStarted => vrchat_running = Some(true),
            EventKind::VrchatStopped => {
                classifications.push(if steamvr_running == Some(true) {
                    classify(
                        event,
                        FailureClass::VrchatFailure,
                        EventConfidence::InferredMedium,
                        vec![EventKind::VrchatStopped, EventKind::SteamVrStarted],
                        "VRChat stopped while SteamVR was last observed running. The process exit is real, but its cause is not yet known.",
                    )
                } else {
                    unknown(
                        event,
                        "VRChat stopped without a correlated live SteamVR observation, so an application failure cannot be distinguished from an intentional or system-wide shutdown.",
                    )
                });
                vrchat_running = Some(false);
            }
            EventKind::HmdDisconnected => {
                classifications.push(if steamvr_running == Some(true) && vrchat_running == Some(true) {
                    classify(
                        event,
                        FailureClass::HmdOrLinkFailure,
                        EventConfidence::InferredMedium,
                        vec![
                            EventKind::HmdDisconnected,
                            EventKind::SteamVrStarted,
                            EventKind::VrchatStarted,
                        ],
                        "The HMD disconnected while SteamVR and VRChat were both last observed running. This supports an HMD/Link corridor failure, but does not distinguish headset, cable, Air Link, or transport causes.",
                    )
                } else {
                    unknown(
                        event,
                        "The HMD disconnected without enough correlated SteamVR and VRChat state to attribute the interruption to the HMD/Link corridor.",
                    )
                });
            }
            EventKind::WindowsSuspend | EventKind::WindowsResume => {
                classifications.push(classify(
                    event,
                    FailureClass::WindowsPowerTransition,
                    EventConfidence::Observed,
                    vec![event.kind],
                    "A Windows suspend/resume transition was directly observed. No additional failure cause is inferred.",
                ));
            }
            EventKind::SessionStarted
            | EventKind::SessionEnded
            | EventKind::HmdConnected
            | EventKind::SteamVrStandbyEntered
            | EventKind::SteamVrStandbyExited
            | EventKind::WindowsPowerEvent
            | EventKind::SleepModeEnabled
            | EventKind::SleepModeDisabled => {}
        }
    }

    SessionReport {
        session_id: events.first().map(|event| event.session_id.clone()),
        observations: events.to_vec(),
        classifications,
    }
}

fn classify(
    event: &SessionEvent,
    category: FailureClass,
    confidence: EventConfidence,
    evidence: Vec<EventKind>,
    rationale: impl Into<String>,
) -> FailureClassification {
    FailureClassification {
        timestamp_utc: event.timestamp_utc.clone(),
        category,
        confidence,
        evidence,
        rationale: rationale.into(),
    }
}

fn unknown(event: &SessionEvent, rationale: impl Into<String>) -> FailureClassification {
    classify(
        event,
        FailureClass::UnknownInsufficientEvidence,
        EventConfidence::InferredLow,
        vec![event.kind],
        rationale,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vsleep::{EventSource, SessionEvent};

    fn event(kind: EventKind) -> SessionEvent {
        let source = match kind {
            EventKind::HmdConnected | EventKind::HmdDisconnected => EventSource::OpenVr,
            EventKind::SteamVrStarted
            | EventKind::SteamVrStopped
            | EventKind::SteamVrStandbyEntered
            | EventKind::SteamVrStandbyExited => EventSource::SteamVr,
            EventKind::VrchatStarted | EventKind::VrchatStopped => EventSource::VrchatProcess,
            EventKind::WindowsSuspend | EventKind::WindowsResume | EventKind::WindowsPowerEvent => {
                EventSource::WindowsPower
            }
            EventKind::SleepModeEnabled | EventKind::SleepModeDisabled => EventSource::SleepMode,
            EventKind::SessionStarted | EventKind::SessionEnded => EventSource::Vsleep,
        };
        SessionEvent::new("session-a", source, kind, EventConfidence::Observed)
    }

    #[test]
    fn keeps_observations_separate_from_inferred_hmd_link_failure() {
        let events = vec![
            event(EventKind::SteamVrStarted),
            event(EventKind::VrchatStarted),
            event(EventKind::HmdDisconnected),
        ];

        let report = build_session_report(&events);

        assert_eq!(report.observations, events);
        assert_eq!(report.classifications.len(), 1);
        assert_eq!(
            report.classifications[0].category,
            FailureClass::HmdOrLinkFailure
        );
        assert_eq!(
            report.classifications[0].confidence,
            EventConfidence::InferredMedium
        );
    }

    #[test]
    fn uses_unknown_when_hmd_disconnect_lacks_correlated_runtime_state() {
        let report = build_session_report(&[event(EventKind::HmdDisconnected)]);

        assert_eq!(report.classifications.len(), 1);
        assert_eq!(
            report.classifications[0].category,
            FailureClass::UnknownInsufficientEvidence
        );
        assert_eq!(
            report.classifications[0].confidence,
            EventConfidence::InferredLow
        );
    }

    #[test]
    fn classifies_peer_process_stop_only_when_other_runtime_is_known_alive() {
        let report = build_session_report(&[
            event(EventKind::VrchatStarted),
            event(EventKind::SteamVrStopped),
        ]);

        assert_eq!(report.classifications.len(), 1);
        assert_eq!(
            report.classifications[0].category,
            FailureClass::SteamVrFailure
        );
        assert_eq!(
            report.classifications[0].confidence,
            EventConfidence::InferredMedium
        );
    }

    #[test]
    fn reports_windows_power_transition_as_observed_not_inferred() {
        let report = build_session_report(&[event(EventKind::WindowsSuspend)]);

        assert_eq!(report.classifications.len(), 1);
        assert_eq!(
            report.classifications[0].category,
            FailureClass::WindowsPowerTransition
        );
        assert_eq!(
            report.classifications[0].confidence,
            EventConfidence::Observed
        );
    }
}
