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
 * timestamp/evidence tuple.
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
    const path = `classifications[${index}].evidence[0]`;

    if (!expectedSource) {
      throw new VSleepReportIntegrityError(
        path,
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
        path,
        `missing authoritative observed trigger ${expectedSource}/${triggerKind} at classification timestamp`
      );
    }
  });

  return report;
}
