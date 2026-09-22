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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct RuntimeUptimeSummary {
    pub observed_up_ms: u64,
    pub observed_down_ms: u64,
    pub unknown_ms: u64,
    pub transitions: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct SessionUptimeSummary {
    pub observed_window_ms: Option<u64>,
    pub hmd: RuntimeUptimeSummary,
    pub steamvr: RuntimeUptimeSummary,
    pub vrchat: RuntimeUptimeSummary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionReport {
    pub session_id: Option<String>,
    pub observations: Vec<SessionEvent>,
    pub classifications: Vec<FailureClassification>,
    pub uptime: SessionUptimeSummary,
}

pub fn build_session_report(events: &[SessionEvent]) -> SessionReport {
    // Classification is stateful, so append order must never be allowed to make a
    // later observation influence an earlier failure inference. Keep raw evidence
    // untouched for the report, but analyze only parseable timestamps in
    // chronological order.
    let analysis_events = chronological_valid_events(events);
    let mut steamvr_running = None;
    let mut vrchat_running = None;
    let mut classifications = Vec::new();

    for event in analysis_events {
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
        uptime: build_uptime_summary(events),
    }
}

fn chronological_valid_events(events: &[SessionEvent]) -> Vec<&SessionEvent> {
    let mut timed_events: Vec<(i64, &SessionEvent)> = events
        .iter()
        .filter_map(|event| {
            chrono::DateTime::parse_from_rfc3339(&event.timestamp_utc)
                .ok()
                .map(|timestamp| (timestamp.timestamp_millis(), event))
        })
        .collect();
    timed_events.sort_by_key(|(timestamp, _)| *timestamp);
    timed_events
        .into_iter()
        .map(|(_, event)| event)
        .collect()
}

fn build_uptime_summary(events: &[SessionEvent]) -> SessionUptimeSummary {
    let mut timed_events: Vec<(i64, EventKind)> = events
        .iter()
        .filter_map(|event| {
            chrono::DateTime::parse_from_rfc3339(&event.timestamp_utc)
                .ok()
                .map(|timestamp| (timestamp.timestamp_millis(), event.kind))
        })
        .collect();

    if timed_events.is_empty() {
        return SessionUptimeSummary::default();
    }

    timed_events.sort_by_key(|(timestamp, _)| *timestamp);
    let window_start = timed_events.first().expect("non-empty timeline").0;
    let window_end = timed_events.last().expect("non-empty timeline").0;
    let observed_window_ms = millis_between(window_start, window_end);

    SessionUptimeSummary {
        observed_window_ms: Some(observed_window_ms),
        hmd: summarize_runtime(
            &timed_events,
            window_start,
            window_end,
            |kind| match kind {
                EventKind::HmdConnected => Some(RuntimeState::Up),
                EventKind::HmdDisconnected => Some(RuntimeState::Down),
                _ => None,
            },
        ),
        steamvr: summarize_runtime(
            &timed_events,
            window_start,
            window_end,
            |kind| match kind {
                EventKind::SteamVrStarted => Some(RuntimeState::Up),
                EventKind::SteamVrStopped => Some(RuntimeState::Down),
                _ => None,
            },
        ),
        vrchat: summarize_runtime(
            &timed_events,
            window_start,
            window_end,
            |kind| match kind {
                EventKind::VrchatStarted => Some(RuntimeState::Up),
                EventKind::VrchatStopped => Some(RuntimeState::Down),
                _ => None,
            },
        ),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeState {
    Up,
    Down,
}

fn summarize_runtime(
    events: &[(i64, EventKind)],
    window_start: i64,
    window_end: i64,
    state_for: fn(EventKind) -> Option<RuntimeState>,
) -> RuntimeUptimeSummary {
    let total_ms = millis_between(window_start, window_end);
    let mut summary = RuntimeUptimeSummary::default();
    let mut state = None;
    let mut last_timestamp = window_start;

    for (timestamp, kind) in events {
        let Some(next_state) = state_for(*kind) else {
            continue;
        };

        if let Some(current_state) = state {
            add_duration(
                &mut summary,
                current_state,
                millis_between(last_timestamp, *timestamp),
            );
            if current_state != next_state {
                summary.transitions += 1;
            }
        }

        state = Some(next_state);
        last_timestamp = *timestamp;
    }

    if let Some(current_state) = state {
        add_duration(
            &mut summary,
            current_state,
            millis_between(last_timestamp, window_end),
        );
    }

    summary.unknown_ms = total_ms.saturating_sub(
        summary
            .observed_up_ms
            .saturating_add(summary.observed_down_ms),
    );
    summary
}

fn add_duration(summary: &mut RuntimeUptimeSummary, state: RuntimeState, duration_ms: u64) {
    match state {
        RuntimeState::Up => {
            summary.observed_up_ms = summary.observed_up_ms.saturating_add(duration_ms)
        }
        RuntimeState::Down => {
            summary.observed_down_ms = summary.observed_down_ms.saturating_add(duration_ms)
        }
    }
}

fn millis_between(start: i64, end: i64) -> u64 {
    end.saturating_sub(start).max(0) as u64
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

    fn event_at(kind: EventKind, timestamp_utc: &str) -> SessionEvent {
        let mut event = event(kind);
        event.timestamp_utc = timestamp_utc.to_string();
        event
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

    #[test]
    fn classification_uses_chronological_valid_events_without_reordering_observations() {
        let events = vec![
            event_at(EventKind::HmdDisconnected, "2026-09-21T00:30:00Z"),
            event_at(EventKind::VrchatStarted, "2026-09-21T00:20:00Z"),
            event_at(EventKind::SteamVrStarted, "2026-09-21T00:10:00Z"),
        ];

        let report = build_session_report(&events);

        assert_eq!(report.observations, events);
        assert_eq!(report.classifications.len(), 1);
        assert_eq!(
            report.classifications[0].category,
            FailureClass::HmdOrLinkFailure
        );
        assert_eq!(
            report.classifications[0].timestamp_utc,
            "2026-09-21T00:30:00Z"
        );
    }

    #[test]
    fn malformed_timestamp_evidence_cannot_mutate_classification_state() {
        let events = vec![
            event_at(EventKind::SteamVrStarted, "2026-09-21T00:10:00Z"),
            event_at(EventKind::VrchatStarted, "malformed-timestamp"),
            event_at(EventKind::HmdDisconnected, "2026-09-21T00:30:00Z"),
        ];

        let report = build_session_report(&events);

        assert_eq!(report.observations, events);
        assert!(report
            .observations
            .iter()
            .any(|event| event.timestamp_utc == "malformed-timestamp"));
        assert_eq!(report.classifications.len(), 1);
        assert_eq!(
            report.classifications[0].category,
            FailureClass::UnknownInsufficientEvidence
        );
    }

    #[test]
    fn summarizes_observed_up_down_and_unknown_time_without_guessing() {
        const MINUTE_MS: u64 = 60_000;

        let report = build_session_report(&[
            event_at(EventKind::SessionStarted, "2026-09-21T00:00:00Z"),
            event_at(EventKind::SteamVrStarted, "2026-09-21T00:10:00Z"),
            event_at(EventKind::VrchatStarted, "2026-09-21T00:20:00Z"),
            event_at(EventKind::SteamVrStopped, "2026-09-21T00:40:00Z"),
            event_at(EventKind::SessionEnded, "2026-09-21T01:00:00Z"),
        ]);

        assert_eq!(report.uptime.observed_window_ms, Some(60 * MINUTE_MS));
        assert_eq!(
            report.uptime.steamvr,
            RuntimeUptimeSummary {
                observed_up_ms: 30 * MINUTE_MS,
                observed_down_ms: 20 * MINUTE_MS,
                unknown_ms: 10 * MINUTE_MS,
                transitions: 1,
            }
        );
        assert_eq!(
            report.uptime.vrchat,
            RuntimeUptimeSummary {
                observed_up_ms: 40 * MINUTE_MS,
                observed_down_ms: 0,
                unknown_ms: 20 * MINUTE_MS,
                transitions: 0,
            }
        );
        assert_eq!(
            report.uptime.hmd,
            RuntimeUptimeSummary {
                observed_up_ms: 0,
                observed_down_ms: 0,
                unknown_ms: 60 * MINUTE_MS,
                transitions: 0,
            }
        );
    }

    #[test]
    fn uptime_summary_uses_chronological_window_even_if_input_is_out_of_order() {
        const MINUTE_MS: u64 = 60_000;

        let report = build_session_report(&[
            event_at(EventKind::VrchatStopped, "2026-09-21T00:45:00Z"),
            event_at(EventKind::SessionStarted, "2026-09-21T00:00:00Z"),
            event_at(EventKind::VrchatStarted, "2026-09-21T00:15:00Z"),
            event_at(EventKind::SessionEnded, "2026-09-21T01:00:00Z"),
        ]);

        assert_eq!(report.uptime.observed_window_ms, Some(60 * MINUTE_MS));
        assert_eq!(
            report.uptime.vrchat,
            RuntimeUptimeSummary {
                observed_up_ms: 30 * MINUTE_MS,
                observed_down_ms: 15 * MINUTE_MS,
                unknown_ms: 15 * MINUTE_MS,
                transitions: 1,
            }
        );
    }
}
