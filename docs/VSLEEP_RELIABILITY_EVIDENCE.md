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

## Derivation invariants

Derived reliability obeys all of the following rules:

- Mixed-session inputs are quarantined from classification and uptime; raw observations are preserved.
- Malformed or unparseable timestamps remain forensic evidence but cannot mutate classifier state.
- Valid evidence is analyzed chronologically rather than in JSONL append order.
- A unique authoritative observed `session_started -> session_ended` pair bounds derived analysis. Partial or ambiguous recordings stay conservative rather than inventing boundaries.
- Events outside a complete authoritative session window do not affect classification or uptime.
- Same-millisecond events are a simultaneous batch. Their append order is not treated as causal order.
- Conflicting same-millisecond start/stop evidence collapses the affected runtime state to unknown.
- Inferred events are never recycled as observed inputs for a later inference.
- Raw facts and inferred classifications remain visually and structurally distinct.
- Recovery actions are out of scope for this contract.

## Failure attribution rule

A failure-like observation may be classified only from runtime state established by earlier authoritative observed evidence. If correlated state is absent, ambiguous, malformed, outside the recording window, inferred, or source-mismatched, the result must fall back to `unknown_insufficient_evidence` rather than upgrading confidence.

Examples:

- `hmd_disconnected` may support `hmd_or_link_failure` only when SteamVR and VRChat were already authoritatively observed running.
- `steam_vr_stopped` may support `steam_vr_failure` only when VRChat was already authoritatively observed running.
- `vrchat_stopped` may support `vrchat_failure` only when SteamVR was already authoritatively observed running.
- `windows_suspend` / `windows_resume` from `windows_power` are direct power-transition observations; no extra root cause is inferred.

## Uptime accounting rule

`observed_up_ms` and `observed_down_ms` may use only authoritative observed runtime-state transitions. Time before the first known state, time after an ambiguity collapses state to unknown, and intervals unsupported by authoritative evidence remain `unknown_ms`.

A report must never turn absence of evidence into downtime.

## Anti-drift review checklist

The source-authority policy is currently enforced in both the core timeline path and persisted-session adapter. Until that policy is physically extracted into one shared helper, every change to `EventSource`, `EventKind`, or the table above must verify both paths stay identical.

For any new producer or event kind, reviewers should check:

- whether the producer directly observes the fact or merely infers it;
- whether the same row is accepted identically by core and persisted report construction;
- whether wrong-source rows remain present in `observations` but inert for derivation;
- whether equal-timestamp ordering is append-order independent;
- whether complete-session windowing is applied consistently to classification and uptime;
- whether tests cover both an accepted source/kind pair and a rejected near-miss pair.

The next implementation cleanup should extract this authority predicate into one shared core helper so the two call paths cannot silently diverge.