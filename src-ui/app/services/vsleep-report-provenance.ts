import { VSleepReportIntegrityError } from './vsleep-report-schema';
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
        Number.isFinite(Date.parse(observation.timestamp_utc))
    )
    .map((observation) => observation.timestamp_utc);
}

function expectedRecordingStatus(
  starts: string[],
  ends: string[]
): VSleepSessionBoundaryStatus {
  if (starts.length > 1 || ends.length > 1) return 'ambiguous_boundaries';
  if (starts.length === 0 && ends.length === 0) return 'missing_both';
  if (starts.length === 0) return 'missing_start';
  if (ends.length === 0) return 'missing_end';
  return Date.parse(ends[0]) < Date.parse(starts[0]) ? 'invalid_order' : 'complete';
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

  if (recording.status === 'complete') {
    const startMs = Date.parse(recording.start_timestamp_utc ?? '');
    const endMs = Date.parse(recording.end_timestamp_utc ?? '');
    const expectedWindowMs = endMs - startMs;
    if (
      Number.isSafeInteger(expectedWindowMs) &&
      report.uptime.observed_window_ms !== expectedWindowMs
    ) {
      throw new VSleepReportIntegrityError(
        'uptime.observed_window_ms',
        `complete recording requires observed window to equal authoritative bounds (${expectedWindowMs})`
      );
    }
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

    // Backend classification applies every unique authoritative recording edge
    // independently. Mirror only that transport invariant here; do not infer a
    // replacement interval when the two unique boundaries are reversed, because
    // the backend deliberately treats invalid_order as evidence-visible but
    // unbounded rather than guessing which edge is wrong.
    if (report.recording && report.recording.status !== 'invalid_order') {
      const classificationMs = Date.parse(classification.timestamp_utc);
      const startMs = report.recording.start_timestamp_utc
        ? Date.parse(report.recording.start_timestamp_utc)
        : null;
      const endMs = report.recording.end_timestamp_utc
        ? Date.parse(report.recording.end_timestamp_utc)
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
