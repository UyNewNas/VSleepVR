# VSleep reliability evidence contract

VSleep reliability reports are observation-first. Raw journal rows are forensic evidence; derived classifications and uptime are a narrower product that may use only evidence whose provenance is strong enough for the fact being asserted.

This document is the review contract for Issue #6 and PR #11. It deliberately does **not** define or authorize recovery behavior.

## Authoritative observed evidence

An event participates in derived reliability only when both conditions hold:

1. `confidence == observed`.
2. The event producer is authoritative for that event kind.

| Event source | Authoritative event kinds |
| --- | --- |
| `vsleep` | `session_started`, `session_ended` |
| `open_vr` | `hmd_connected`, `hmd_disconnected` |
| `steam_vr` | `steam_vr_started`, `steam_vr_stopped`, `steam_vr_standby_entered`, `steam_vr_standby_exited` |
| `vrchat_process` | `vrchat_started`, `vrchat_stopped` |
| `vrchat_log` | none for derived reliability |
| `windows_power` | `windows_suspend`, `windows_resume`, `windows_power_event` |
| `sleep_mode` | `sleep_mode_enabled`, `sleep_mode_disabled` |

A source/kind mismatch must remain visible in `SessionReport.observations` but must not establish runtime state, alter the authoritative session window, emit a derived power classification, or contribute to observed uptime.

The source-authority policy has one implementation point: `timeline::is_authoritative_reliability_observation`. Both direct core report construction and the persisted-session adapter consume that predicate, so source/kind trust cannot silently drift between the two paths.

The current observe-only HMD, SteamVR-process, and VRChat-process producers also route their writes through `observer::record_authoritative_observation`. That guard checks the same shared authority predicate before persistence and drops a mismatched `observed` row instead of allowing a future producer-edit bug to enter the journal as reliability evidence. The generic journal API intentionally remains permissive so inferred, forensic, legacy, or externally reconstructed rows can still be retained and shown without being promoted into derived reliability.

The real producer functions are covered from the write side by `producer_contract_tests::observe_only_producers_emit_only_authoritative_observed_pairs`, while `observer::tests::production_observer_guard_rejects_non_authoritative_observed_rows_before_persistence` verifies the new fail-closed write guard itself. The producer contract regression invokes the real HMD, SteamVR-process, and VRChat-process observer entry points, checks their exact `source + kind + observed` tuples, and verifies that the persisted journal contains only authority-qualified rows plus the VSleep session boundaries. This complements the classifier-side 420-combination authority matrix with a producer-side contract.

## Recording completeness

`SessionReport.recording` is the backend-owned recording-integrity summary. It exposes `status`, `start_timestamp_utc`, and `end_timestamp_utc` so CLI/UI/export consumers do not have to independently reinterpret raw boundary rows.

Frontend consumers must prefer `SessionReport.recording` whenever it is present. `VSleepReportService` keeps raw-observation boundary derivation only as a compatibility fallback for reports generated before the backend summary existed. An `ambiguous_session` summary is fail-closed for derived frontend classifications and incident windows while raw observations remain visible.

The Tauri payload boundary validates report structure before the UI trusts derived data. Validation failures are surfaced as a distinct `VSleepReportIntegrityError`, and the Overview renders a read-only integrity-failure state instead of treating the payload like an ordinary transport error. The persisted JSONL is left unchanged; no repair, rewrite, restart, reconnect, or other recovery action is attempted automatically.

The status is conservative and source-qualified:

- `complete`: one authoritative, parseable start and one authoritative, parseable end in chronological order;
- `missing_start` / `missing_end` / `missing_both`: the corresponding authoritative edge is absent;
- `invalid_order`: both unique edges exist but the end precedes the start;
- `ambiguous_boundaries`: at least one side has more than one authoritative, parseable boundary; a unique opposite edge is still retained as a trustworthy one-sided bound;
- `ambiguous_session`: the core report was asked to correlate observations from more than one session, so no recording boundary claim is made.

Malformed, inferred, or wrong-source boundary rows remain forensic observations but cannot upgrade the recording status or establish an edge.

## Derivation invariants

Derived reliability obeys all of the following rules:

- Mixed-session inputs are quarantined from classification and uptime; raw observations are preserved.
- Malformed or unparseable timestamps remain forensic evidence but cannot mutate classifier state.
- Valid evidence is analyzed chronologically rather than in JSONL append order.
- Each unique authoritative session boundary is usable independently. A known `session_started` still excludes earlier evidence when `session_ended` is missing or ambiguous, and a known `session_ended` still excludes later evidence when `session_started` is missing or ambiguous.
- A unique authoritative `session_started -> session_ended` pair bounds both sides. If the two unique edges are reversed, the pair is internally inconsistent and is not converted into a guessed interval.
- Events outside any trustworthy known session bound do not affect classification or uptime.
- Same-millisecond events are a simultaneous batch. Their append order is not treated as causal order.
- Conflicting same-millisecond start/stop evidence collapses the affected runtime state to unknown.
- Inferred events are never recycled as observed inputs for a later inference.
- Raw facts and inferred classifications remain visually and structurally distinct.
- Recovery actions are out of scope for this contract.

## Failure attribution rule

A failure-like observation may be classified only from runtime state established by earlier authoritative observed evidence. If correlated state is absent, ambiguous, malformed, outside the trustworthy recording bounds, inferred, or source-mismatched, the result must fall back to `unknown_insufficient_evidence` rather than upgrading confidence.

Examples:

- `hmd_disconnected` may support `hmd_or_link_failure` only when SteamVR and VRChat were already authoritatively observed running.
- `steam_vr_stopped` may support `steam_vr_failure` only when VRChat was already authoritatively observed running.
- `vrchat_stopped` may support `vrchat_failure` only when SteamVR was already authoritatively observed running.
- `windows_suspend` / `windows_resume` from `windows_power` are direct power-transition observations; no extra root cause is inferred.

## Derived classification payload integrity

`SessionReport.classifications` is backend-owned derived data, so the Tauri-to-UI boundary validates it more strictly than raw forensic observations. Classification timestamps must be parseable, rationales must be non-empty, unknown categories/evidence enum values fail closed, and each current category must match the confidence/evidence contract emitted by `timeline.rs`:

- `hmd_or_link_failure`: `inferred_medium` with `hmd_disconnected`, `steam_vr_started`, `vrchat_started` evidence;
- `steam_vr_failure`: `inferred_medium` with `steam_vr_stopped`, `vrchat_started` evidence;
- `vrchat_failure`: `inferred_medium` with `vrchat_stopped`, `steam_vr_started` evidence;
- `windows_power_transition`: `observed` with exactly one `windows_suspend` or `windows_resume` evidence item;
- `unknown_insufficient_evidence`: `inferred_low` with exactly one HMD/SteamVR/VRChat failure-like trigger observation.

The transport boundary also cross-checks each derived classification against the raw observations carried in the same report. Its first evidence item must have a same-session, same-timestamp, directly observed trigger from the authoritative producer. When backend-owned recording metadata exposes a trustworthy start and/or end edge, the classification timestamp must also lie inside every known edge. One-sided bounds retained by `missing_start`, `missing_end`, or `ambiguous_boundaries` are enforced independently. `invalid_order` remains deliberately unbounded because the backend itself refuses to guess a usable interval from contradictory edges. Legacy reports without `recording` metadata retain compatibility rather than inventing new bounds in the frontend.

This strictness is intentional. Raw journal source/kind strings stay forward-compatible and visible for future forensic producers, but a future backend change to derived classification semantics must update the frontend contract in the same reviewed change instead of silently being trusted as an existing diagnosis. Validation failure remains read-only and never rewrites the journal or initiates recovery.

## Uptime accounting rule

`observed_up_ms` and `observed_down_ms` may use only authoritative observed runtime-state transitions. Time before the first known state, time after an ambiguity collapses state to unknown, and intervals unsupported by authoritative evidence remain `unknown_ms`.

For a partial recording, `observed_window_ms` uses every trustworthy boundary that exists. The missing side falls back only to the first/last authoritative timestamp actually present in the journal; it is therefore an observed evidence span, not a claim that the VSleep session began earlier or continued later.

The report transport treats uptime as an integrity-qualified derived summary rather than three unrelated counters. For every runtime, `observed_up_ms + observed_down_ms + unknown_ms` must equal `observed_window_ms` exactly. All duration and transition fields must be non-negative safe integers. If `observed_window_ms` is `null`, the backend has no trustworthy timed evidence window and every runtime summary must remain at the zero-valued default. Payloads that violate these cross-field invariants fail closed before UI adapters consume them; raw journal evidence is not rewritten.

A report must never turn absence of evidence into downtime.

## Anti-drift review checklist

For any new producer or event kind, reviewers should check:

- whether the producer directly observes the fact or merely infers it;
- whether `timeline::is_authoritative_reliability_observation` accepts or rejects the pair intentionally;
- whether reliability-authoritative production writes pass through the fail-closed observer guard rather than calling the generic journal writer directly;
- whether the real producer path is covered by a producer-side contract test, not only by classifier fixtures;
- whether the same row is accepted identically by core and persisted report construction;
- whether wrong-source rows remain present in `observations` but inert for derivation;
- whether equal-timestamp ordering is append-order independent;
- whether complete and partial session bounds are applied consistently to classification, uptime, recording completeness, and the frontend report view;
- whether backend-owned derived classification enum/confidence/evidence changes update the frontend runtime schema in the same reviewed change;
- whether tests cover both an accepted source/kind pair and a rejected near-miss pair.
