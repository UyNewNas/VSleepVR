use super::event::{EventConfidence, EventKind, EventSource, SessionEvent};
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionRecordingStatus {
    Complete,
    MissingStart,
    MissingEnd,
    MissingBoth,
    InvalidOrder,
    AmbiguousBoundaries,
    AmbiguousSession,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionRecordingSummary {
    pub status: SessionRecordingStatus,
    pub start_timestamp_utc: Option<String>,
    pub end_timestamp_utc: Option<String>,
}

impl Default for SessionRecordingSummary {
    fn default() -> Self {
        Self {
            status: SessionRecordingStatus::MissingBoth,
            start_timestamp_utc: None,
            end_timestamp_utc: None,
        }
    }
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
    pub recording: SessionRecordingSummary,
    pub observations: Vec<SessionEvent>,
    pub classifications: Vec<FailureClassification>,
    pub uptime: SessionUptimeSummary,
}

pub fn build_session_report(events: &[SessionEvent]) -> SessionReport {
    // Derived reliability data is only meaningful when every observation belongs
    // to one unambiguous session. Preserve mixed-session evidence verbatim, but do
    // not choose a session on the caller's behalf or correlate state across them.
    let session_id = unambiguous_session_id(events);
    let recording = if session_id.is_some() {
        summarize_session_recording(events)
    } else if events.is_empty() {
        SessionRecordingSummary::default()
    } else {
        SessionRecordingSummary {
            status: SessionRecordingStatus::AmbiguousSession,
            start_timestamp_utc: None,
            end_timestamp_utc: None,
        }
    };

    // Classification is stateful, so append order must never be allowed to make a
    // later observation influence an earlier failure inference. Keep raw evidence
    // untouched for the report, but analyze only directly observed events with
    // parseable timestamps in chronological order. Any unique authoritative
    // recording edge bounds analysis on that side, so a truncated recording does
    // not let pre-session or post-session evidence mutate in-session state.
    //
    // Events sharing the same millisecond are treated as a simultaneous batch:
    // failure-like observations in such a batch are not causally ordered against
    // their peers, and runtime state changes are applied only after the whole batch
    // is classified. This keeps equal-timestamp JSONL append order from changing a
    // later diagnosis.
    let analysis_events = session_id
        .map(|_| chronological_valid_events(events))
        .unwrap_or_default();
    let mut steamvr_running = None;
    let mut vrchat_running = None;
    let mut classifications = Vec::new();
    let mut index = 0;

    while index < analysis_events.len() {
        let timestamp = analysis_events[index].0;
        let mut batch_end = index + 1;
        while batch_end < analysis_events.len() && analysis_events[batch_end].0 == timestamp {
            batch_end += 1;
        }

        let batch = &analysis_events[index..batch_end];
        let ambiguous_same_timestamp = batch.len() > 1;

        for (_, event) in batch.iter().copied() {
            match event.kind {
                EventKind::SteamVrStarted => {}
                EventKind::SteamVrStopped => {
                    classifications.push(if ambiguous_same_timestamp {
                        unknown(
                            event,
                            "Multiple observed reliability transitions share this timestamp, so their causal order is unknown and the SteamVR stop is not attributed to a specific failure.",
                        )
                    } else if vrchat_running == Some(true) {
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
                }
                EventKind::VrchatStarted => {}
                EventKind::VrchatStopped => {
                    classifications.push(if ambiguous_same_timestamp {
                        unknown(
                            event,
                            "Multiple observed reliability transitions share this timestamp, so their causal order is unknown and the VRChat stop is not attributed to a specific failure.",
                        )
                    } else if steamvr_running == Some(true) {
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
                }
                EventKind::HmdDisconnected => {
                    classifications.push(if ambiguous_same_timestamp {
                        unknown(
                            event,
                            "Multiple observed reliability transitions share this timestamp, so their causal order is unknown and the HMD disconnect is not attributed to a specific runtime corridor.",
                        )
                    } else if steamvr_running == Some(true) && vrchat_running == Some(true) {
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

        steamvr_running = runtime_state_after_batch(
            steamvr_running,
            batch,
            EventKind::SteamVrStarted,
            EventKind::SteamVrStopped,
        );
        vrchat_running = runtime_state_after_batch(
            vrchat_running,
            batch,
            EventKind::VrchatStarted,
            EventKind::VrchatStopped,
        );
        index = batch_end;
    }

    SessionReport {
        session_id: session_id.map(str::to_string),
        recording,
        observations: events.to_vec(),
        classifications,
        uptime: session_id
            .map(|_| build_uptime_summary(events))
            .unwrap_or_default(),
    }
}

fn runtime_state_after_batch(
    current: Option<bool>,
    batch: &[(i64, &SessionEvent)],
    started_kind: EventKind,
    stopped_kind: EventKind,
) -> Option<bool> {
    let saw_started = batch
        .iter()
        .any(|(_, event)| event.kind == started_kind);
    let saw_stopped = batch
        .iter()
        .any(|(_, event)| event.kind == stopped_kind);

    match (saw_started, saw_stopped) {
        (true, false) => Some(true),
        (false, true) => Some(false),
        (true, true) => None,
        (false, false) => current,
    }
}

fn unambiguous_session_id(events: &[SessionEvent]) -> Option<&str> {
    let session_id = events.first()?.session_id.as_str();
    events
        .iter()
        .all(|event| event.session_id.as_str() == session_id)
        .then_some(session_id)
}

pub(crate) fn is_authoritative_reliability_observation(event: &SessionEvent) -> bool {
    if event.confidence != EventConfidence::Observed {
        return false;
    }

    match event.source {
        EventSource::Vsleep => {
            matches!(event.kind, EventKind::SessionStarted | EventKind::SessionEnded)
        }
        EventSource::OpenVr => {
            matches!(event.kind, EventKind::HmdConnected | EventKind::HmdDisconnected)
        }
        EventSource::SteamVr => matches!(
            event.kind,
            EventKind::SteamVrStarted
                | EventKind::SteamVrStopped
                | EventKind::SteamVrStandbyEntered
                | EventKind::SteamVrStandbyExited
        ),
        EventSource::VrchatProcess => {
            matches!(event.kind, EventKind::VrchatStarted | EventKind::VrchatStopped)
        }
        EventSource::VrchatLog => false,
        EventSource::WindowsPower => matches!(
            event.kind,
            EventKind::WindowsSuspend | EventKind::WindowsResume | EventKind::WindowsPowerEvent
        ),
        EventSource::SleepMode => matches!(
            event.kind,
            EventKind::SleepModeEnabled | EventKind::SleepModeDisabled
        ),
    }
}

fn chronological_valid_events(events: &[SessionEvent]) -> Vec<(i64, &SessionEvent)> {
    let (start_bound, end_bound) = observed_session_bounds(events);
    let mut timed_events: Vec<(i64, &SessionEvent)> = events
        .iter()
        .filter(|event| is_authoritative_reliability_observation(event))
        .filter_map(|event| {
            chrono::DateTime::parse_from_rfc3339(&event.timestamp_utc)
                .ok()
                .map(|timestamp| (timestamp.timestamp_millis(), event))
        })
        .filter(|(timestamp, _)| {
            start_bound.map(|start| *timestamp >= start).unwrap_or(true)
                && end_bound.map(|end| *timestamp <= end).unwrap_or(true)
        })
        .collect();
    timed_events.sort_by_key(|(timestamp, _)| *timestamp);
    timed_events
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BoundaryCandidate<'a> {
    Missing,
    Unique {
        timestamp_utc: &'a str,
        timestamp_ms: i64,
    },
    Ambiguous,
}

fn authoritative_session_boundary(
    events: &[SessionEvent],
    kind: EventKind,
) -> BoundaryCandidate<'_> {
    let mut boundaries = events
        .iter()
        .filter(|event| event.kind == kind && is_authoritative_reliability_observation(event))
        .filter_map(|event| {
            chrono::DateTime::parse_from_rfc3339(&event.timestamp_utc)
                .ok()
                .map(|timestamp| (event.timestamp_utc.as_str(), timestamp.timestamp_millis()))
        });

    let Some((timestamp_utc, timestamp_ms)) = boundaries.next() else {
        return BoundaryCandidate::Missing;
    };
    if boundaries.next().is_some() {
        return BoundaryCandidate::Ambiguous;
    }

    BoundaryCandidate::Unique {
        timestamp_utc,
        timestamp_ms,
    }
}

pub(crate) fn summarize_session_recording(events: &[SessionEvent]) -> SessionRecordingSummary {
    let start = authoritative_session_boundary(events, EventKind::SessionStarted);
    let end = authoritative_session_boundary(events, EventKind::SessionEnded);

    let start_timestamp_utc = match start {
        BoundaryCandidate::Unique { timestamp_utc, .. } => Some(timestamp_utc.to_string()),
        BoundaryCandidate::Missing | BoundaryCandidate::Ambiguous => None,
    };
    let end_timestamp_utc = match end {
        BoundaryCandidate::Unique { timestamp_utc, .. } => Some(timestamp_utc.to_string()),
        BoundaryCandidate::Missing | BoundaryCandidate::Ambiguous => None,
    };

    let status = match (start, end) {
        (BoundaryCandidate::Ambiguous, _) | (_, BoundaryCandidate::Ambiguous) => {
            SessionRecordingStatus::AmbiguousBoundaries
        }
        (BoundaryCandidate::Missing, BoundaryCandidate::Missing) => {
            SessionRecordingStatus::MissingBoth
        }
        (BoundaryCandidate::Missing, BoundaryCandidate::Unique { .. }) => {
            SessionRecordingStatus::MissingStart
        }
        (BoundaryCandidate::Unique { .. }, BoundaryCandidate::Missing) => {
            SessionRecordingStatus::MissingEnd
        }
        (
            BoundaryCandidate::Unique {
                timestamp_ms: start_ms,
                ..
            },
            BoundaryCandidate::Unique {
                timestamp_ms: end_ms,
                ..
            },
        ) if end_ms < start_ms => SessionRecordingStatus::InvalidOrder,
        (BoundaryCandidate::Unique { .. }, BoundaryCandidate::Unique { .. }) => {
            SessionRecordingStatus::Complete
        }
    };

    SessionRecordingSummary {
        status,
        start_timestamp_utc,
        end_timestamp_utc,
    }
}

fn observed_session_bounds(events: &[SessionEvent]) -> (Option<i64>, Option<i64>) {
    let recording = summarize_session_recording(events);

    // Two individually authoritative edges that disagree on ordering are not a
    // usable interval. Preserve the current evidence-visible behavior instead of
    // guessing which edge is wrong. If only one edge is unique, however, that edge
    // is still a trustworthy one-sided bound for a partial/ambiguous recording.
    if recording.status == SessionRecordingStatus::InvalidOrder {
        return (None, None);
    }

    let parse_bound = |timestamp_utc: Option<&str>| {
        timestamp_utc.and_then(|timestamp_utc| {
            chrono::DateTime::parse_from_rfc3339(timestamp_utc)
                .ok()
                .map(|timestamp| timestamp.timestamp_millis())
        })
    };

    (
        parse_bound(recording.start_timestamp_utc.as_deref()),
        parse_bound(recording.end_timestamp_utc.as_deref()),
    )
}

fn build_uptime_summary(events: &[SessionEvent]) -> SessionUptimeSummary {
    let mut timed_events: Vec<(i64, EventKind)> = events
        .iter()
        .filter(|event| is_authoritative_reliability_observation(event))
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
    let fallback_start = timed_events.first().expect("non-empty timeline").0;
    let fallback_end = timed_events.last().expect("non-empty timeline").0;
    let (start_bound, end_bound) = observed_session_bounds(events);
    let window_start = start_bound.unwrap_or(fallback_start);
    let window_end = end_bound.unwrap_or(fallback_end);
    let observed_window_ms = millis_between(window_start, window_end);
    let bounded_events: Vec<(i64, EventKind)> = timed_events
        .into_iter()
        .filter(|(timestamp, _)| *timestamp >= window_start && *timestamp <= window_end)
        .collect();

    SessionUptimeSummary {
        observed_window_ms: Some(observed_window_ms),
        hmd: summarize_runtime(
            &bounded_events,
            window_start,
            window_end,
            |kind| match kind {
                EventKind::HmdConnected => Some(RuntimeState::Up),
                EventKind::HmdDisconnected => Some(RuntimeState::Down),
                _ => None,
            },
        ),
        steamvr: summarize_runtime(
            &bounded_events,
            window_start,
            window_end,
            |kind| match kind {
                EventKind::SteamVrStarted => Some(RuntimeState::Up),
                EventKind::SteamVrStopped => Some(RuntimeState::Down),
                _ => None,
            },
        ),
        vrchat: summarize_runtime(
            &bounded_events,
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
    let mut index = 0;

    while index < events.len() {
        let timestamp = events[index].0;
        let mut batch_end = index + 1;
        while batch_end < events.len() && events[batch_end].0 == timestamp {
            batch_end += 1;
        }

        let mut saw_up = false;
        let mut saw_down = false;
        for (_, kind) in &events[index..batch_end] {
            match state_for(*kind) {
                Some(RuntimeState::Up) => saw_up = true,
                Some(RuntimeState::Down) => saw_down = true,
                None => {}
            }
        }

        if saw_up || saw_down {
            if let Some(current_state) = state {
                add_duration(
                    &mut summary,
                    current_state,
                    millis_between(last_timestamp, timestamp),
                );
            }

            let next_state = match (saw_up, saw_down) {
                (true, false) => Some(RuntimeState::Up),
                (false, true) => Some(RuntimeState::Down),
                (true, true) => None,
                (false, false) => unreachable!("runtime state batch must contain a state signal"),
            };

            if let (Some(current_state), Some(next_state)) = (state, next_state) {
                if current_state != next_state {
                    summary.transitions += 1;
                }
            }

            state = next_state;
            last_timestamp = timestamp;
        }

        index = batch_end;
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
            event_at(EventKind::SteamVrStarted, "2026-09-21T00:10:00Z"),
            event_at(EventKind::VrchatStarted, "2026-09-21T00:20:00Z"),
            event_at(EventKind::HmdDisconnected, "2026-09-21T00:30:00Z"),
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
            event_at(EventKind::VrchatStarted, "2026-09-21T00:10:00Z"),
            event_at(EventKind::SteamVrStopped, "2026-09-21T00:20:00Z"),
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
    fn mixed_session_input_preserves_observations_but_refuses_derived_data() {
        let mut foreign_vrchat = event_at(EventKind::VrchatStarted, "2026-09-21T00:20:00Z");
        foreign_vrchat.session_id = "session-b".to_string();
        let events = vec![
            event_at(EventKind::SteamVrStarted, "2026-09-21T00:10:00Z"),
            foreign_vrchat,
            event_at(EventKind::HmdDisconnected, "2026-09-21T00:30:00Z"),
        ];

        let report = build_session_report(&events);

        assert_eq!(report.session_id, None);
        assert_eq!(report.recording.status, SessionRecordingStatus::AmbiguousSession);
        assert_eq!(report.observations, events);
        assert!(report.classifications.is_empty());
        assert_eq!(report.uptime, SessionUptimeSummary::default());
    }

    #[test]
    fn recording_summary_is_first_class_and_source_qualified() {
        let complete = build_session_report(&[
            event_at(EventKind::SessionStarted, "2026-09-21T00:00:00Z"),
            event_at(EventKind::SessionEnded, "2026-09-21T01:00:00Z"),
        ]);
        assert_eq!(
            complete.recording,
            SessionRecordingSummary {
                status: SessionRecordingStatus::Complete,
                start_timestamp_utc: Some("2026-09-21T00:00:00Z".to_string()),
                end_timestamp_utc: Some("2026-09-21T01:00:00Z".to_string()),
            }
        );

        let missing_end = build_session_report(&[event_at(
            EventKind::SessionStarted,
            "2026-09-21T00:00:00Z",
        )]);
        assert_eq!(missing_end.recording.status, SessionRecordingStatus::MissingEnd);
        assert_eq!(
            missing_end.recording.start_timestamp_utc.as_deref(),
            Some("2026-09-21T00:00:00Z")
        );
        assert_eq!(missing_end.recording.end_timestamp_utc, None);

        let missing_start = build_session_report(&[event_at(
            EventKind::SessionEnded,
            "2026-09-21T01:00:00Z",
        )]);
        assert_eq!(
            missing_start.recording.status,
            SessionRecordingStatus::MissingStart
        );
        assert_eq!(missing_start.recording.start_timestamp_utc, None);
        assert_eq!(
            missing_start.recording.end_timestamp_utc.as_deref(),
            Some("2026-09-21T01:00:00Z")
        );

        let missing_both = build_session_report(&[event_at(
            EventKind::HmdConnected,
            "2026-09-21T00:30:00Z",
        )]);
        assert_eq!(
            missing_both.recording.status,
            SessionRecordingStatus::MissingBoth
        );

        let invalid_order = build_session_report(&[
            event_at(EventKind::SessionStarted, "2026-09-21T01:00:00Z"),
            event_at(EventKind::SessionEnded, "2026-09-21T00:00:00Z"),
        ]);
        assert_eq!(
            invalid_order.recording.status,
            SessionRecordingStatus::InvalidOrder
        );

        let ambiguous = build_session_report(&[
            event_at(EventKind::SessionStarted, "2026-09-21T00:00:00Z"),
            event_at(EventKind::SessionStarted, "2026-09-21T00:05:00Z"),
            event_at(EventKind::SessionEnded, "2026-09-21T01:00:00Z"),
        ]);
        assert_eq!(
            ambiguous.recording.status,
            SessionRecordingStatus::AmbiguousBoundaries
        );
        assert_eq!(ambiguous.recording.start_timestamp_utc, None);
        assert_eq!(
            ambiguous.recording.end_timestamp_utc.as_deref(),
            Some("2026-09-21T01:00:00Z")
        );

        let mut forged_end = event_at(EventKind::SessionEnded, "2026-09-21T01:00:00Z");
        forged_end.source = EventSource::OpenVr;
        let source_qualified = build_session_report(&[
            event_at(EventKind::SessionStarted, "2026-09-21T00:00:00Z"),
            forged_end,
        ]);
        assert_eq!(
            source_qualified.recording.status,
            SessionRecordingStatus::MissingEnd
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
    fn same_timestamp_state_changes_are_conservative_and_append_order_independent() {
        const MINUTE_MS: u64 = 60_000;

        let forward = build_session_report(&[
            event_at(EventKind::SessionStarted, "2026-09-21T00:00:00Z"),
            event_at(EventKind::VrchatStarted, "2026-09-21T00:05:00Z"),
            event_at(EventKind::SteamVrStarted, "2026-09-21T00:10:00Z"),
            event_at(EventKind::SteamVrStarted, "2026-09-21T00:20:00Z"),
            event_at(EventKind::SteamVrStopped, "2026-09-21T00:20:00Z"),
            event_at(EventKind::HmdDisconnected, "2026-09-21T00:30:00Z"),
            event_at(EventKind::SessionEnded, "2026-09-21T01:00:00Z"),
        ]);
        let reverse = build_session_report(&[
            event_at(EventKind::SessionStarted, "2026-09-21T00:00:00Z"),
            event_at(EventKind::VrchatStarted, "2026-09-21T00:05:00Z"),
            event_at(EventKind::SteamVrStarted, "2026-09-21T00:10:00Z"),
            event_at(EventKind::SteamVrStopped, "2026-09-21T00:20:00Z"),
            event_at(EventKind::SteamVrStarted, "2026-09-21T00:20:00Z"),
            event_at(EventKind::HmdDisconnected, "2026-09-21T00:30:00Z"),
            event_at(EventKind::SessionEnded, "2026-09-21T01:00:00Z"),
        ]);

        assert_eq!(forward.classifications, reverse.classifications);
        assert_eq!(forward.classifications.len(), 2);
        assert!(forward
            .classifications
            .iter()
            .all(|classification| classification.category == FailureClass::UnknownInsufficientEvidence));
        assert_eq!(
            forward.uptime.steamvr,
            RuntimeUptimeSummary {
                observed_up_ms: 10 * MINUTE_MS,
                observed_down_ms: 0,
                unknown_ms: 50 * MINUTE_MS,
                transitions: 0,
            }
        );
        assert_eq!(forward.uptime.steamvr, reverse.uptime.steamvr);
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
    fn classification_uses_complete_session_bounds_and_ignores_outside_runtime_evidence() {
        let events = vec![
            event_at(EventKind::SteamVrStarted, "2026-09-20T23:50:00Z"),
            event_at(EventKind::VrchatStarted, "2026-09-20T23:55:00Z"),
            event_at(EventKind::SessionStarted, "2026-09-21T00:00:00Z"),
            event_at(EventKind::HmdDisconnected, "2026-09-21T00:10:00Z"),
            event_at(EventKind::SteamVrStarted, "2026-09-21T00:20:00Z"),
            event_at(EventKind::VrchatStarted, "2026-09-21T00:30:00Z"),
            event_at(EventKind::SessionEnded, "2026-09-21T01:00:00Z"),
            event_at(EventKind::HmdDisconnected, "2026-09-21T01:10:00Z"),
        ];

        let report = build_session_report(&events);

        assert_eq!(report.observations, events);
        assert_eq!(report.classifications.len(), 1);
        assert_eq!(
            report.classifications[0].category,
            FailureClass::UnknownInsufficientEvidence
        );
        assert_eq!(
            report.classifications[0].timestamp_utc,
            "2026-09-21T00:10:00Z"
        );
    }

    #[test]
    fn classification_uses_known_start_when_session_end_is_missing() {
        let events = vec![
            event_at(EventKind::SteamVrStarted, "2026-09-20T23:50:00Z"),
            event_at(EventKind::VrchatStarted, "2026-09-20T23:55:00Z"),
            event_at(EventKind::SessionStarted, "2026-09-21T00:00:00Z"),
            event_at(EventKind::HmdDisconnected, "2026-09-21T00:10:00Z"),
        ];

        let report = build_session_report(&events);

        assert_eq!(report.observations, events);
        assert_eq!(report.classifications.len(), 1);
        assert_eq!(
            report.classifications[0].category,
            FailureClass::UnknownInsufficientEvidence
        );
        assert_eq!(
            report.classifications[0].timestamp_utc,
            "2026-09-21T00:10:00Z"
        );
    }

    #[test]
    fn classification_uses_known_end_when_session_start_is_missing() {
        let events = vec![
            event_at(EventKind::SteamVrStarted, "2026-09-21T00:20:00Z"),
            event_at(EventKind::VrchatStarted, "2026-09-21T00:30:00Z"),
            event_at(EventKind::SessionEnded, "2026-09-21T01:00:00Z"),
            event_at(EventKind::HmdDisconnected, "2026-09-21T01:10:00Z"),
        ];

        let report = build_session_report(&events);

        assert_eq!(report.observations, events);
        assert!(report.classifications.is_empty());
    }

    #[test]
    fn inferred_observations_cannot_drive_classification_or_observed_uptime() {
        const MINUTE_MS: u64 = 60_000;

        let mut inferred_steamvr =
            event_at(EventKind::SteamVrStarted, "2026-09-21T00:10:00Z");
        inferred_steamvr.confidence = EventConfidence::InferredHigh;
        let mut inferred_suspend =
            event_at(EventKind::WindowsSuspend, "2026-09-21T00:40:00Z");
        inferred_suspend.confidence = EventConfidence::InferredHigh;
        let events = vec![
            event_at(EventKind::SessionStarted, "2026-09-21T00:00:00Z"),
            inferred_steamvr,
            event_at(EventKind::VrchatStarted, "2026-09-21T00:20:00Z"),
            event_at(EventKind::HmdDisconnected, "2026-09-21T00:30:00Z"),
            inferred_suspend,
            event_at(EventKind::SessionEnded, "2026-09-21T01:00:00Z"),
        ];

        let report = build_session_report(&events);

        assert_eq!(report.observations, events);
        assert_eq!(report.classifications.len(), 1);
        assert_eq!(
            report.classifications[0].category,
            FailureClass::UnknownInsufficientEvidence
        );
        assert_eq!(
            report.classifications[0].timestamp_utc,
            "2026-09-21T00:30:00Z"
        );
        assert!(!report
            .classifications
            .iter()
            .any(|classification| classification.category == FailureClass::WindowsPowerTransition));
        assert_eq!(
            report.uptime.steamvr,
            RuntimeUptimeSummary {
                observed_up_ms: 0,
                observed_down_ms: 0,
                unknown_ms: 60 * MINUTE_MS,
                transitions: 0,
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
    }

    #[test]
    fn core_report_requires_authoritative_sources_for_derived_reliability() {
        const MINUTE_MS: u64 = 60_000;

        let mut forged_boundary =
            event_at(EventKind::SessionStarted, "2026-09-21T00:05:00Z");
        forged_boundary.source = EventSource::OpenVr;
        let mut forged_steamvr =
            event_at(EventKind::SteamVrStarted, "2026-09-21T00:10:00Z");
        forged_steamvr.source = EventSource::VrchatLog;
        let mut forged_suspend =
            event_at(EventKind::WindowsSuspend, "2026-09-21T00:40:00Z");
        forged_suspend.source = EventSource::Vsleep;

        let events = vec![
            event_at(EventKind::HmdDisconnected, "2026-09-20T23:50:00Z"),
            event_at(EventKind::SessionStarted, "2026-09-21T00:00:00Z"),
            forged_boundary,
            forged_steamvr,
            event_at(EventKind::VrchatStarted, "2026-09-21T00:20:00Z"),
            event_at(EventKind::HmdDisconnected, "2026-09-21T00:30:00Z"),
            forged_suspend,
            event_at(EventKind::SessionEnded, "2026-09-21T01:00:00Z"),
        ];

        let report = build_session_report(&events);

        assert_eq!(report.observations, events);
        assert_eq!(report.classifications.len(), 1);
        assert_eq!(
            report.classifications[0].category,
            FailureClass::UnknownInsufficientEvidence
        );
        assert_eq!(
            report.classifications[0].timestamp_utc,
            "2026-09-21T00:30:00Z"
        );
        assert!(!report
            .classifications
            .iter()
            .any(|classification| classification.category == FailureClass::WindowsPowerTransition));
        assert_eq!(report.uptime.observed_window_ms, Some(60 * MINUTE_MS));
        assert_eq!(
            report.uptime.steamvr,
            RuntimeUptimeSummary {
                observed_up_ms: 0,
                observed_down_ms: 0,
                unknown_ms: 60 * MINUTE_MS,
                transitions: 0,
            }
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

    #[test]
    fn uptime_summary_uses_complete_session_bounds_and_ignores_outside_runtime_events() {
        const MINUTE_MS: u64 = 60_000;

        let events = vec![
            event_at(EventKind::VrchatStarted, "2026-09-20T23:50:00Z"),
            event_at(EventKind::SessionStarted, "2026-09-21T00:00:00Z"),
            event_at(EventKind::VrchatStarted, "2026-09-21T00:10:00Z"),
            event_at(EventKind::VrchatStopped, "2026-09-21T00:40:00Z"),
            event_at(EventKind::SessionEnded, "2026-09-21T01:00:00Z"),
            event_at(EventKind::VrchatStarted, "2026-09-21T01:10:00Z"),
        ];

        let report = build_session_report(&events);

        assert_eq!(report.observations, events);
        assert_eq!(report.uptime.observed_window_ms, Some(60 * MINUTE_MS));
        assert_eq!(
            report.uptime.vrchat,
            RuntimeUptimeSummary {
                observed_up_ms: 30 * MINUTE_MS,
                observed_down_ms: 20 * MINUTE_MS,
                unknown_ms: 10 * MINUTE_MS,
                transitions: 1,
            }
        );
    }

    #[test]
    fn uptime_summary_uses_known_start_when_session_end_is_missing() {
        const MINUTE_MS: u64 = 60_000;

        let events = vec![
            event_at(EventKind::VrchatStarted, "2026-09-20T23:50:00Z"),
            event_at(EventKind::SessionStarted, "2026-09-21T00:00:00Z"),
            event_at(EventKind::VrchatStarted, "2026-09-21T00:10:00Z"),
            event_at(EventKind::VrchatStopped, "2026-09-21T00:40:00Z"),
        ];

        let report = build_session_report(&events);

        assert_eq!(report.observations, events);
        assert_eq!(report.uptime.observed_window_ms, Some(40 * MINUTE_MS));
        assert_eq!(
            report.uptime.vrchat,
            RuntimeUptimeSummary {
                observed_up_ms: 30 * MINUTE_MS,
                observed_down_ms: 0,
                unknown_ms: 10 * MINUTE_MS,
                transitions: 1,
            }
        );
    }

    #[test]
    fn uptime_summary_uses_known_end_when_session_start_is_missing() {
        const MINUTE_MS: u64 = 60_000;

        let events = vec![
            event_at(EventKind::VrchatStarted, "2026-09-21T00:10:00Z"),
            event_at(EventKind::VrchatStopped, "2026-09-21T00:40:00Z"),
            event_at(EventKind::SessionEnded, "2026-09-21T01:00:00Z"),
            event_at(EventKind::VrchatStarted, "2026-09-21T01:10:00Z"),
        ];

        let report = build_session_report(&events);

        assert_eq!(report.observations, events);
        assert_eq!(report.uptime.observed_window_ms, Some(50 * MINUTE_MS));
        assert_eq!(
            report.uptime.vrchat,
            RuntimeUptimeSummary {
                observed_up_ms: 30 * MINUTE_MS,
                observed_down_ms: 20 * MINUTE_MS,
                unknown_ms: 0,
                transitions: 1,
            }
        );
    }
}
