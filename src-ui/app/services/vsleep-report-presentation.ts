import { parseVSleepRfc3339TimestampMs } from './vsleep-report-timestamp';
import type {
  VSleepEventConfidence,
  VSleepEventKind,
  VSleepEventSource,
  VSleepSessionBoundaryStatus,
  VSleepSessionEvent,
} from './vsleep-report.service';

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

export function vsleepClassificationEvidenceLabel(confidence: VSleepEventConfidence): string {
  switch (confidence) {
    case 'observed':
      return 'derived · observed evidence';
    case 'inferred_high':
      return 'inferred · high';
    case 'inferred_medium':
      return 'inferred · medium';
    case 'inferred_low':
      return 'inferred · low';
  }
}

export function vsleepClassificationIsInference(confidence: VSleepEventConfidence): boolean {
  return confidence !== 'observed';
}

export function vsleepRecordingIntegrityEvidenceLabel(
  status: VSleepSessionBoundaryStatus
): string {
  switch (status) {
    case 'complete':
      return 'derived · authoritative start/end';
    case 'missing_start':
      return 'derived · authoritative end only';
    case 'missing_end':
      return 'derived · authoritative start only';
    case 'missing_both':
      return 'derived · no authoritative session boundaries';
    case 'invalid_order':
      return 'derived · contradictory boundary pair';
    case 'ambiguous_boundaries':
      return 'derived · duplicate boundary evidence';
    case 'ambiguous_session':
      return 'quarantined · mixed session evidence';
  }
}

export function vsleepUptimeEvidenceLabel(
  status: VSleepSessionBoundaryStatus,
  observedWindowMs: number | null
): string {
  if (observedWindowMs === null) return 'derived accounting · no trustworthy timed window';

  switch (status) {
    case 'complete':
      return 'derived accounting · bounded by session start/end';
    case 'missing_start':
    case 'missing_end':
    case 'ambiguous_boundaries':
      return 'derived accounting · partial evidence window';
    case 'missing_both':
    case 'invalid_order':
      return 'derived accounting · authoritative evidence span';
    case 'ambiguous_session':
      return 'derived accounting · quarantined mixed-session evidence';
  }
}
