import { parseVSleepRfc3339TimestampMs } from './vsleep-report-timestamp';
import type { VSleepEventKind, VSleepEventSource, VSleepSessionEvent } from './vsleep-report.service';

const authoritativePresentationKinds: Partial<
  Record<VSleepEventSource, ReadonlySet<VSleepEventKind>>
> = {
  vsleep: new Set(['session_started', 'session_ended']),
  open_vr: new Set(['hmd_connected', 'hmd_disconnected']),
  steam_vr: new Set([
    'steam_vr_started',
    'steam_vr_stopped',
    'steam_vr_standby_entered',
    'steam_vr_standby_exited',
  ]),
  vrchat_process: new Set(['vrchat_started', 'vrchat_stopped']),
  windows_power: new Set(['windows_suspend', 'windows_resume', 'windows_power_event']),
  sleep_mode: new Set(['sleep_mode_enabled', 'sleep_mode_disabled']),
};

type VSleepPresentationObservation = Pick<
  VSleepSessionEvent,
  'timestamp_utc' | 'source' | 'kind' | 'confidence'
>;

function isPresentationQualifiedObservation(observation: VSleepPresentationObservation): boolean {
  if (observation.confidence !== 'observed') return false;
  if (parseVSleepRfc3339TimestampMs(observation.timestamp_utc) === null) return false;
  return authoritativePresentationKinds[observation.source]?.has(observation.kind) === true;
}

export function vsleepObservationEvidenceLabel(observation: VSleepPresentationObservation): string {
  return isPresentationQualifiedObservation(observation)
    ? 'observed'
    : `forensic · ${observation.confidence}`;
}

export function vsleepObservationMarker(observation: VSleepPresentationObservation): '●' | '○' {
  return isPresentationQualifiedObservation(observation) ? '●' : '○';
}
