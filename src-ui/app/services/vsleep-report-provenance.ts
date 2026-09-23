import { VSleepReportIntegrityError } from './vsleep-report-schema';
import { parseVSleepRfc3339TimestampMs } from './vsleep-report-timestamp';
import type {
  VSleepEventKind,
  VSleepEventSource,
  VSleepSessionBoundaryStatus,
  VSleepSessionReport,
} from './vsleep-report.service';

const authoritativeTriggerSources: Partial<Record<VSleepEventKind, VSleepEventSource>> = {
  hmd_disconnected: 'open_vr',
  steam_vr_stopped: 'steam_vr',
  vrchat_stopped: 'vrchat_process',
  windows_suspend: 'windows_power',
  windows_resume: 'windows_power',
};

const authoritativeObservationKinds: Partial<
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

function requireBackendTimestampMs(timestampUtc: string, path: string): number {
  const timestampMs = parseVSleepRfc3339TimestampMs(timestampUtc);
  if (timestampMs === null) {
    throw new VSleepReportIntegrityError(path, 'expected parseable timestamp in RFC3339 format');
  }
  return timestampMs;
}

function authoritativeBoundaryTimestamps(
  report: VSleepSessionReport,
  kind: Extract<VSleepEventKind, 'session_started' | 'session_ended'>
): string[] {
  return report.observations
    .filter(
      (observation) =>
        observation.source === 'vsleep' &&
        observation.kind === kind &&
        observation.confidence === 'observed' &&
        parseVSleepRfc3339TimestampMs(observation.timestamp_utc) !== null
    )
    .map((observation) => observation.timestamp_utc);
}

function authoritativeObservationTimestampRange(
  report: VSleepSessionReport
): { firstMs: number; lastMs: number } | null {
  let firstMs: number | null = null;
  let lastMs: number | null = null;

  for (const observation of report.observations) {
    if (observation.confidence !== 'observed') continue;
    const allowedKinds = authoritativeObservationKinds[observation.source];
    if (!allowedKinds?.has(observation.kind)) continue;

    const timestampMs = parseVSleepRfc3339TimestampMs(observation.timestamp_utc);
    if (timestampMs === null) continue;
    firstMs = firstMs === null ? timestampMs : Math.min(firstMs, timestampMs);
    lastMs = lastMs === null ? timestampMs : Math.max(lastMs, timestampMs);
  }

  return firstMs === null || lastMs === null ? null : { firstMs, lastMs };
}

function expectedObservedWindowMs(report: VSleepSessionReport): number | null {
  const range = authoritativeObservationTimestampRange(report);
  if (!range) return null;

  const recording = report.recording;
  const ignoreRecordingBounds = recording?.status === 'invalid_order';
  const startMs =
    !ignoreRecordingBounds && recording?.start_timestamp_utc
      ? requireBackendTimestampMs(recording.start_timestamp_utc, 'recording.start_timestamp_utc')
      : range.firstMs;
  const endMs =
    !ignoreRecordingBounds && recording?.end_timestamp_utc
      ? requireBackendTimestampMs(recording.end_timestamp_utc, 'recording.end_timestamp_utc')
      : range.lastMs;
  const observedWindowMs = Math.max(endMs - startMs, 0);

  if (!Number.isSafeInteger(observedWindowMs)) {
    throw new VSleepReportIntegrityError(
      'uptime.observed_window_ms',
      'authoritative evidence window exceeds the JavaScript safe integer range'
    );
  }

  return observedWindowMs;
}

function expectedRecordingStatus(
  starts: string[],
  ends: string[]
): VSleepSessionBoundaryStatus {
  if (starts.length > 1 || ends.length > 1) return 'ambiguous_boundaries';
  if (starts.length === 0 && ends.length === 0) return 'missing_both';
  if (starts.length === 0) return 'missing_start';
  if (ends.length === 0) return 'missing_end';
  const startMs = parseVSleepRfc3339TimestampMs(starts[0]);
  const endMs = parseVSleepRfc3339TimestampMs(ends[0]);
  return endMs !== null && startMs !== null && endMs < startMs ? 'invalid_order' : 'complete';
}

function validateBackendOwnedRecordingProvenance(report: VSleepSessionReport): void {
  const recording = report.recording;
  if (!recording || recording.status === 'ambiguous_session') return;

  const starts = authoritativeBoundaryTimestamps(report, 'session_started');
  const ends = authoritativeBoundaryTimestamps(report, 'session_ended');
  const expectedStart = starts.length === 1 ? starts[0] : null;
  const expectedEnd = ends.length === 1 ? ends[0] : null;

  if (recording.start_timestamp_utc !== expectedStart) {
    throw new VSleepReportIntegrityError(
      'recording.start_timestamp_utc',
      `backend recording start does not match raw authoritative boundary (${expectedStart ?? 'none'})`
    );
  }

  if (recording.end_timestamp_utc !== expectedEnd) {
    throw new VSleepReportIntegrityError(
      'recording.end_timestamp_utc',
      `backend recording end does not match raw authoritative boundary (${expectedEnd ?? 'none'})`
    );
  }

  const expectedStatus = expectedRecordingStatus(starts, ends);
  if (recording.status !== expectedStatus) {
    throw new VSleepReportIntegrityError(
      'recording.status',
      `backend recording status does not match raw authoritative boundaries (${expectedStatus})`
    );
  }
}

function validateBackendOwnedReportConsistency(report: VSleepSessionReport): void {
  const recording = report.recording;
  if (!recording) return;

  if (report.session_id === null) {
    if (report.classifications.length !== 0) {
      throw new VSleepReportIntegrityError(
        'classifications',
        'derived classifications require an unambiguous session_id'
      );
    }

    if (report.uptime.observed_window_ms !== null) {
      throw new VSleepReportIntegrityError(
        'uptime.observed_window_ms',
        'sessionless reports require a null observed window'
      );
    }

    const expectedStatus = report.observations.length === 0 ? 'missing_both' : 'ambiguous_session';
    if (recording.status !== expectedStatus) {
      throw new VSleepReportIntegrityError(
        'recording.status',
        `sessionless report with ${report.observations.length === 0 ? 'no' : 'mixed'} observations requires ${expectedStatus}`
      );
    }
    return;
  }

  if (report.observations.length === 0) {
    throw new VSleepReportIntegrityError(
      'session_id',
      'non-null session_id requires at least one observation'
    );
  }

  const mismatchedObservationIndex = report.observations.findIndex(
    (observation) => observation.session_id !== report.session_id
  );
  if (mismatchedObservationIndex !== -1) {
    throw new VSleepReportIntegrityError(
      `observations[${mismatchedObservationIndex}].session_id`,
      'current backend report observations must match session_id'
    );
  }

  const expectedWindowMs = expectedObservedWindowMs(report);
  if (report.uptime.observed_window_ms !== expectedWindowMs) {
    const detail =
      recording.status === 'complete'
        ? `complete recording requires observed window to equal authoritative bounds (${expectedWindowMs})`
        : `${recording.status} recording requires observed window to equal the backend authoritative-evidence window (${expectedWindowMs ?? 'null'})`;
    throw new VSleepReportIntegrityError('uptime.observed_window_ms', detail);
  }
}

/**
 * Cross-check backend-owned classifications against the raw journal evidence
 * carried in the same report. The runtime schema already validates the shape and
 * category/confidence/evidence contract; this layer makes sure backend-owned
 * recording edges and failure-like triggers were not fabricated independently
 * of the forensic observations.
 *
 * This is intentionally narrower than re-running the backend classifier in the
 * frontend. Supporting runtime state remains backend-owned. We only require the
 * directly observed trigger that the backend copies into the classification
 * timestamp/evidence tuple, prove recording metadata against authoritative raw
 * session boundaries, and enforce consistency with trustworthy recording bounds.
 */
export function validateVSleepClassificationProvenance(
  report: VSleepSessionReport
): VSleepSessionReport {
  validateBackendOwnedReportConsistency(report);
  if (report.classifications.length === 0) {
    validateBackendOwnedRecordingProvenance(report);
    return report;
  }

  if (report.session_id === null) {
    throw new VSleepReportIntegrityError(
      'classifications',
      'derived classifications require an unambiguous session_id'
    );
  }

  report.classifications.forEach((classification, index) => {
    const triggerKind = classification.evidence[0];
    const expectedSource = authoritativeTriggerSources[triggerKind];
    const evidencePath = `classifications[${index}].evidence[0]`;
    const timestampPath = `classifications[${index}].timestamp_utc`;
    const classificationMs = requireBackendTimestampMs(classification.timestamp_utc, timestampPath);

    // Backend classification applies every unique authoritative recording edge
    // independently. Mirror only that transport invariant here; do not infer a
    // replacement interval when the two unique boundaries are reversed, because
    // the backend deliberately treats invalid_order as evidence-visible but
    // unbounded rather than guessing which edge is wrong.
    if (report.recording && report.recording.status !== 'invalid_order') {
      const startMs = report.recording.start_timestamp_utc
        ? requireBackendTimestampMs(
            report.recording.start_timestamp_utc,
            'recording.start_timestamp_utc'
          )
        : null;
      const endMs = report.recording.end_timestamp_utc
        ? requireBackendTimestampMs(report.recording.end_timestamp_utc, 'recording.end_timestamp_utc')
        : null;

      if (startMs !== null && classificationMs < startMs) {
        throw new VSleepReportIntegrityError(
          timestampPath,
          'derived classification precedes authoritative recording start'
        );
      }
      if (endMs !== null && classificationMs > endMs) {
        throw new VSleepReportIntegrityError(
          timestampPath,
          'derived classification follows authoritative recording end'
        );
      }
    }

    if (!expectedSource) {
      throw new VSleepReportIntegrityError(
        evidencePath,
        `no authoritative trigger source is defined for ${triggerKind}`
      );
    }

    const hasAuthoritativeTrigger = report.observations.some(
      (observation) =>
        observation.session_id === report.session_id &&
        observation.timestamp_utc === classification.timestamp_utc &&
        observation.source === expectedSource &&
        observation.kind === triggerKind &&
        observation.confidence === 'observed'
    );

    if (!hasAuthoritativeTrigger) {
      throw new VSleepReportIntegrityError(
        evidencePath,
        `missing authoritative observed trigger ${expectedSource}/${triggerKind} at classification timestamp`
      );
    }
  });

  validateBackendOwnedRecordingProvenance(report);
  return report;
}
