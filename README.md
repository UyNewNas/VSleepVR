# VSleepVR

> Reliable VR sleeping, keep-alive, observability and recovery for SteamVR + VRChat.

VSleepVR is a fork of [Raphiiko/OyasumiVR](https://github.com/Raphiiko/OyasumiVR), with a narrower goal: **keep a VR sleeping session alive and diagnosable through the night**, especially for PCVR headsets connected through a runtime bridge such as Meta Quest Link.

The fork intentionally keeps OyasumiVR's mature SteamVR/OpenVR, VRChat, OSC, Windows, overlay and automation infrastructure while adding a reliability layer around long-running sleep sessions.

## Project goals

- Keep SteamVR and VRChat sessions alive through long idle periods.
- Detect and record HMD disconnect / reconnect, SteamVR state changes and VRChat process changes.
- Distinguish likely failure layers: headset/runtime link, SteamVR, VRChat, Windows power management, or network/session loss.
- Provide a session timeline that explains what happened overnight.
- Add conservative recovery actions with explicit user opt-in.
- Preserve useful OyasumiVR sleep automations instead of reimplementing them from scratch.

## Initial target

The first hardware/runtime corridor is:

```
Meta Quest 3S
  -> Meta Quest Link / Air Link
  -> SteamVR 2.x (OpenVR integration)
  -> VRChat
```

Other SteamVR headsets remain in scope, but the first reliability tests will focus on this corridor.

## Planned VSleep reliability layer

```
VR session
   |
   +-- HMD / OpenVR state monitor
   +-- SteamVR process/runtime monitor
   +-- VRChat process + log monitor
   +-- Windows sleep inhibition
   +-- session event journal
   +-- recovery policy engine
   |
   +--> overnight session report
```

Example report:

```
23:48  Sleep detected
02:41  HMD disconnected
02:41  SteamVR runtime still alive
02:42  VRChat process still alive
02:47  HMD reconnected
07:31  Awake detected

VRChat uptime: 100%
HMD disconnected: 6m
```

## Development strategy

- `develop` stays close to upstream OyasumiVR where practical.
- VSleep-specific work is developed in focused feature branches.
- Upstream bug fixes and runtime compatibility changes should be merged regularly.
- VSleep-specific behavior should be isolated behind modules/interfaces where possible to keep upstream synchronization manageable.

See [docs/VSLEEP_ARCHITECTURE.md](docs/VSLEEP_ARCHITECTURE.md) for the initial architecture and implementation plan.

## Upstream and attribution

VSleepVR is based on **OyasumiVR** by Raphiiko and contributors.

- Upstream: https://github.com/Raphiiko/OyasumiVR
- License: MIT
- Original project features, translations, assets and contributor history remain credited to the upstream project and their respective authors.

This fork is not affiliated with or endorsed by VRChat Inc., Valve, or Meta.
