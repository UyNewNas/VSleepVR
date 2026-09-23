import { VSleepReportIntegrityError } from './vsleep-report-schema';
import type {
  VSleepEventKind,
  VSleepEventSource,
  VSleepSessionReport,
} from './vsleep-report.service';

const authoritativeTriggerSources: Partial<Record<VSleepEventKind, VSleepEventSource>> = {
  hmd_disconnected: 'open_vr',
  steam_vr_stopped: 'steam_vr',
  vrchat_stopped: 'vrchat_process',
  windows_suspend: 'windows_power',
  windows_resume: 'windows_power',
};

/**
 * Cross-check backend-owned classifications against the raw journal evidence
 * carried in the same report. The runtime schema already validates the shape and
 * category/confidence/evidence contract; this layer makes sure the failure-like
 * trigger was not fabricated independently of the forensic observations.
 *
 * This is intentionally narrower than re-running the backend classifier in the
 * frontend. Supporting runtime state remains backend-owned. We only require the
 * directly observed trigger that the backend copies into the classification
 * timestamp/evidence tuple, plus consistency with any trustworthy recording
 * bounds the backend already exposed.
 */
export function validateVSleepClassificationProvenance(
  report: VSleepSessionReport
): VSleepSessionReport {
  if (report.classifications.length === 0) return report;

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

  return report;
}
