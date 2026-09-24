# VSleepVR reliability architecture

## 1. Scope

VSleepVR extends OyasumiVR with a reliability and observability layer for overnight VRChat sessions.

The primary problem is not merely detecting sleep. It is determining **why a user disappeared from VRChat while sleeping**, and where possible preventing or safely recovering from that failure.

Initial corridor:

```
Quest 3S -> Quest Link/Air Link -> SteamVR -> VRChat
```

## 2. Existing upstream capabilities to reuse

OyasumiVR already provides useful infrastructure that VSleepVR should avoid duplicating:

- OpenVR / SteamVR integration under `src-core/src/openvr`
- Steam integration under `src-core/src/steam`
- VRChat log parsing under `src-core/src/vrc_log_parser`
- OSC support under `src-core/src/osc`
- OS integration under `src-core/src/os`
- telemetry/error infrastructure
- Angular UI and SteamVR overlay
- existing sleep state / automation machinery

The first implementation should add new reliability services beside these modules rather than rewrite them.

## 3. New modules

Proposed Rust-side layout:

```
src-core/src/vsleep/
  mod.rs
  event.rs
  session.rs
  monitor/
    mod.rs
    hmd.rs
    steamvr.rs
    vrchat.rs
    windows.rs
  journal/
    mod.rs
    writer.rs
    reader.rs
  recovery/
    mod.rs
    policy.rs
    actions.rs
```

### Event model

All monitored state transitions should become normalized events.

Examples:

- `HmdConnected`
- `HmdDisconnected`
- `SteamVrStarted`
- `SteamVrStopped`
- `SteamVrStandbyEntered`
- `SteamVrStandbyExited`
- `VrchatStarted`
- `VrchatStopped`
- `VrchatWorldJoined`
- `VrchatWorldLeft`
- `WindowsSuspendImminent`
- `SleepModeEnabled`
- `SleepModeDisabled`

Each event should carry a timestamp, source, confidence level where inference is involved, and optional diagnostic metadata.

## 4. Session journal

A sleep session journal is the core MVP.

Requirements:

- append-only during a session;
- survive UI restarts where possible;
- readable by the UI without parsing application logs;
- bounded retention;
- no VRChat credentials or unnecessary personal data.

Suggested first format: JSON Lines in the app data directory.

A later migration to SQLite is reasonable if querying/reporting grows complex.

### Forensic read contract

The journal reader should preserve evidence without silently repairing it:

- UI-facing reads accept only a basename for a `.jsonl` file under the journal root, not an arbitrary filesystem path;
- the selected entry must be a regular file; symlinks, directories, and other non-regular file objects are rejected;
- a complete final JSON record is valid even when it has no trailing newline;
- an unterminated malformed final record may be treated as a torn crash/power-loss tail only when at least one earlier record was parsed successfully;
- malformed newline-terminated records, or a malformed only/first record, remain hard read errors;
- tolerant reads never truncate, rewrite, or synthesize journal content.

Writers flush each JSONL record before returning it to callers. This improves crash readability but is not a storage-device durability guarantee: without an explicit `fsync`/equivalent policy, sudden power loss can still leave the final record absent or torn. The reader contract therefore favors preserving already-flushed evidence while failing closed on durable corruption.

## 5. Watchdog

The watchdog should observe first and act second.

### Phase A — observe only

No automatic restart behavior. Record:

- OpenVR HMD presence / tracked-device state;
- SteamVR runtime/process state;
- VRChat process state;
- VRChat log-derived world/session state;
- Windows power-state transitions.

This phase exists to establish what actually happens when Quest Link disconnects or a headset is removed.

### Phase B — safe prevention

Opt-in actions:

- request Windows execution-state inhibition while a VSleep session is active;
- warn when a SteamVR idle/standby policy is likely to terminate the intended session;
- surface unstable Link reconnect cycles.

### Phase C — recovery

Recovery must be explicit and policy-driven.

Possible actions:

- wait for HMD reconnect while keeping VRChat untouched;
- restart SteamVR only when VRChat has already exited;
- restart VRChat after an unexpected process exit;
- never automatically rejoin a private instance without a deliberately supported, safe mechanism.

## 6. Failure classification

The overnight report should classify failures conservatively:

| Layer | Evidence |
| --- | --- |
| HMD / Link | OpenVR HMD disappears while SteamVR remains alive |
| SteamVR | runtime/process stops before VRChat exits |
| VRChat | VRChat process exits while SteamVR remains healthy |
| Windows | suspend/power transition precedes runtime loss |
| Unknown | evidence is insufficient or conflicting |

Avoid pretending inference is certainty. Reports should distinguish observed events from inferred cause.

## 7. Quest-specific audit

Before implementing recovery, verify on Quest 3S:

1. What OpenVR events appear when the HMD is removed?
2. What events appear when Quest Link disconnects?
3. Does SteamVR enter standby without terminating VRChat?
4. What happens when Link reconnects?
5. Does VRChat remain in-world while no HMD is reported?
6. How does Air Link differ from wired Link?
7. Which behaviors are controlled by SteamVR versus Meta runtime settings?

The result should become a reproducible compatibility matrix.

## 8. Privacy / security

VSleep-specific features should work without VRChat account credentials whenever possible.

Principles:

- prefer local process state, OpenVR and VRChat logs;
- keep journals local by default;
- do not record chat/audio;
- do not persist instance identifiers longer than needed for diagnostics unless the user opts in;
- automatic recovery actions should be transparent and individually configurable.

## 9. MVP completion criteria

MVP is complete when VSleepVR can run an overnight session and, the next morning:

1. show the session start/end;
2. show HMD connect/disconnect transitions;
3. show SteamVR start/stop/standby transitions detectable through available APIs;
4. show VRChat process lifetime;
5. identify Windows sleep/suspend involvement;
6. export a concise diagnostic timeline;
7. inhibit Windows sleep while explicitly enabled;
8. perform no destructive/restart action by default.

Only after this baseline should automatic recovery become a default development priority.
