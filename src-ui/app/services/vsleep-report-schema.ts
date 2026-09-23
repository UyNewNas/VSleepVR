import type {
  VSleepSessionRecordingSummary,
  VSleepSessionReport,
} from './vsleep-report.service';

const recordingStatuses = new Set([
  'complete',
  'missing_start',
  'missing_end',
  'missing_both',
  'invalid_order',
  'ambiguous_boundaries',
  'ambiguous_session',
]);

const failureClasses = new Set([
  'hmd_or_link_failure',
  'steam_vr_failure',
  'vrchat_failure',
  'windows_power_transition',
  'unknown_insufficient_evidence',
]);

const classificationEvidenceKinds = new Set([
  'session_started',
  'session_ended',
  'hmd_connected',
  'hmd_disconnected',
  'steam_vr_started',
  'steam_vr_stopped',
  'steam_vr_standby_entered',
  'steam_vr_standby_exited',
  'vrchat_started',
  'vrchat_stopped',
  'windows_suspend',
  'windows_resume',
  'windows_power_event',
  'sleep_mode_enabled',
  'sleep_mode_disabled',
]);

const unknownFailureTriggerKinds = new Set([
  'hmd_disconnected',
  'steam_vr_stopped',
  'vrchat_stopped',
]);

export class VSleepReportIntegrityError extends Error {
  constructor(
    readonly path: string,
    readonly detail: string
  ) {
    super(`Invalid VSleep session report payload at ${path}: ${detail}`);
    this.name = 'VSleepReportIntegrityError';
  }
}

function fail(path: string, detail: string): never {
  throw new VSleepReportIntegrityError(path, detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string') fail(path, 'expected string');
}

function requireNonEmptyString(value: unknown, path: string): asserts value is string {
  requireString(value, path);
  if (value.trim().length === 0) fail(path, 'expected non-empty string');
}

function requireNullableString(value: unknown, path: string): asserts value is string | null {
  if (value !== null && typeof value !== 'string') fail(path, 'expected string or null');
}

function requireNonNegativeNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(path, 'expected finite non-negative number');
  }
}

function requireNonNegativeInteger(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(path, 'expected non-negative safe integer');
  }
}

function requireTimestamp(value: unknown, path: string): asserts value is string {
  requireString(value, path);
  if (!Number.isFinite(Date.parse(value))) fail(path, 'expected parseable timestamp');
}

function requireTimestampOrNull(value: unknown, path: string): asserts value is string | null {
  requireNullableString(value, path);
  if (typeof value === 'string' && !Number.isFinite(Date.parse(value))) {
    fail(path, 'expected parseable timestamp or null');
  }
}

function validateObservation(value: unknown, index: number): void {
  const path = `observations[${index}]`;
  if (!isRecord(value)) fail(path, 'expected object');
  requireNonNegativeNumber(value['schema_version'], `${path}.schema_version`);
  requireString(value['timestamp_utc'], `${path}.timestamp_utc`);
  requireString(value['session_id'], `${path}.session_id`);
  requireString(value['source'], `${path}.source`);
  requireString(value['kind'], `${path}.kind`);
  requireString(value['confidence'], `${path}.confidence`);
}

function requireExactEvidence(
  evidence: string[],
  expected: string[],
  path: string
): void {
  if (
    evidence.length !== expected.length ||
    evidence.some((kind, evidenceIndex) => kind !== expected[evidenceIndex])
  ) {
    fail(path, `expected backend evidence sequence ${expected.join(', ')}`);
  }
}

function validateClassificationContract(
  category: string,
  confidence: string,
  evidence: string[],
  path: string
): void {
  switch (category) {
    case 'hmd_or_link_failure':
      if (confidence !== 'inferred_medium') {
        fail(`${path}.confidence`, 'hmd_or_link_failure requires inferred_medium');
      }
      requireExactEvidence(
        evidence,
        ['hmd_disconnected', 'steam_vr_started', 'vrchat_started'],
        `${path}.evidence`
      );
      break;
    case 'steam_vr_failure':
      if (confidence !== 'inferred_medium') {
        fail(`${path}.confidence`, 'steam_vr_failure requires inferred_medium');
      }
      requireExactEvidence(
        evidence,
        ['steam_vr_stopped', 'vrchat_started'],
        `${path}.evidence`
      );
      break;
    case 'vrchat_failure':
      if (confidence !== 'inferred_medium') {
        fail(`${path}.confidence`, 'vrchat_failure requires inferred_medium');
      }
      requireExactEvidence(
        evidence,
        ['vrchat_stopped', 'steam_vr_started'],
        `${path}.evidence`
      );
      break;
    case 'windows_power_transition':
      if (confidence !== 'observed') {
        fail(`${path}.confidence`, 'windows_power_transition requires observed');
      }
      if (
        evidence.length !== 1 ||
        (evidence[0] !== 'windows_suspend' && evidence[0] !== 'windows_resume')
      ) {
        fail(`${path}.evidence`, 'windows_power_transition requires one suspend/resume observation');
      }
      break;
    case 'unknown_insufficient_evidence':
      if (confidence !== 'inferred_low') {
        fail(`${path}.confidence`, 'unknown_insufficient_evidence requires inferred_low');
      }
      if (evidence.length !== 1 || !unknownFailureTriggerKinds.has(evidence[0])) {
        fail(
          `${path}.evidence`,
          'unknown_insufficient_evidence requires one failure-like trigger observation'
        );
      }
      break;
    default:
      fail(`${path}.category`, `unknown category ${category}`);
  }
}

function validateClassification(value: unknown, index: number): void {
  const path = `classifications[${index}]`;
  if (!isRecord(value)) fail(path, 'expected object');

  requireTimestamp(value['timestamp_utc'], `${path}.timestamp_utc`);

  const category = value['category'];
  requireString(category, `${path}.category`);
  if (!failureClasses.has(category)) {
    fail(`${path}.category`, `unknown category ${category}`);
  }

  const confidence = value['confidence'];
  requireString(confidence, `${path}.confidence`);
  requireNonEmptyString(value['rationale'], `${path}.rationale`);

  const rawEvidence = value['evidence'];
  if (!Array.isArray(rawEvidence)) fail(`${path}.evidence`, 'expected array');
  const evidence = rawEvidence.map((entry, evidenceIndex) => {
    const evidencePath = `${path}.evidence[${evidenceIndex}]`;
    requireString(entry, evidencePath);
    if (!classificationEvidenceKinds.has(entry)) {
      fail(evidencePath, `unknown derived evidence kind ${entry}`);
    }
    return entry;
  });

  validateClassificationContract(category, confidence, evidence, path);
}

interface ValidatedRuntimeUptime {
  observedUpMs: number;
  observedDownMs: number;
  unknownMs: number;
  transitions: number;
}

function validateRuntimeUptime(value: unknown, path: string): ValidatedRuntimeUptime {
  if (!isRecord(value)) fail(path, 'expected object');
  requireNonNegativeInteger(value['observed_up_ms'], `${path}.observed_up_ms`);
  requireNonNegativeInteger(value['observed_down_ms'], `${path}.observed_down_ms`);
  requireNonNegativeInteger(value['unknown_ms'], `${path}.unknown_ms`);
  requireNonNegativeInteger(value['transitions'], `${path}.transitions`);
  return {
    observedUpMs: value['observed_up_ms'],
    observedDownMs: value['observed_down_ms'],
    unknownMs: value['unknown_ms'],
    transitions: value['transitions'],
  };
}

function validateRuntimeUptimeAccounting(
  runtime: ValidatedRuntimeUptime,
  path: string,
  observedWindowMs: number | null
): void {
  if (observedWindowMs === null) {
    if (
      runtime.observedUpMs !== 0 ||
      runtime.observedDownMs !== 0 ||
      runtime.unknownMs !== 0 ||
      runtime.transitions !== 0
    ) {
      fail(path, 'expected zero runtime summary when observed_window_ms is null');
    }
    return;
  }

  const accountedMs = runtime.observedUpMs + runtime.observedDownMs + runtime.unknownMs;
  if (!Number.isSafeInteger(accountedMs) || accountedMs !== observedWindowMs) {
    fail(path, `runtime durations must sum to observed_window_ms (${observedWindowMs})`);
  }
}

function validateUptime(value: unknown): void {
  if (!isRecord(value)) fail('uptime', 'expected object');
  const observedWindow = value['observed_window_ms'];
  if (observedWindow !== null) {
    requireNonNegativeInteger(observedWindow, 'uptime.observed_window_ms');
  }

  const hmd = validateRuntimeUptime(value['hmd'], 'uptime.hmd');
  const steamvr = validateRuntimeUptime(value['steamvr'], 'uptime.steamvr');
  const vrchat = validateRuntimeUptime(value['vrchat'], 'uptime.vrchat');
  validateRuntimeUptimeAccounting(hmd, 'uptime.hmd', observedWindow as number | null);
  validateRuntimeUptimeAccounting(steamvr, 'uptime.steamvr', observedWindow as number | null);
  validateRuntimeUptimeAccounting(vrchat, 'uptime.vrchat', observedWindow as number | null);
}

function validateRecording(
  value: unknown,
  sessionId: string | null
): asserts value is VSleepSessionRecordingSummary {
  if (!isRecord(value)) fail('recording', 'expected object');
  requireString(value['status'], 'recording.status');
  if (!recordingStatuses.has(value['status'])) {
    fail('recording.status', `unknown status ${value['status']}`);
  }

  requireTimestampOrNull(value['start_timestamp_utc'], 'recording.start_timestamp_utc');
  requireTimestampOrNull(value['end_timestamp_utc'], 'recording.end_timestamp_utc');

  const status = value['status'];
  const start = value['start_timestamp_utc'];
  const end = value['end_timestamp_utc'];
  const startMs = typeof start === 'string' ? Date.parse(start) : null;
  const endMs = typeof end === 'string' ? Date.parse(end) : null;

  switch (status) {
    case 'complete':
      if (startMs === null || endMs === null || endMs < startMs) {
        fail('recording', 'complete requires ordered start and end timestamps');
      }
      break;
    case 'missing_start':
      if (start !== null || endMs === null) {
        fail('recording', 'missing_start requires null start and a valid end timestamp');
      }
      break;
    case 'missing_end':
      if (startMs === null || end !== null) {
        fail('recording', 'missing_end requires a valid start timestamp and null end');
      }
      break;
    case 'missing_both':
      if (start !== null || end !== null) {
        fail('recording', 'missing_both requires null start and end timestamps');
      }
      break;
    case 'invalid_order':
      if (startMs === null || endMs === null || endMs >= startMs) {
        fail('recording', 'invalid_order requires end before start');
      }
      break;
    case 'ambiguous_session':
      if (sessionId !== null || start !== null || end !== null) {
        fail('recording', 'ambiguous_session requires null session_id and boundaries');
      }
      break;
    case 'ambiguous_boundaries':
      break;
  }
}

export function parseVSleepSessionReport(payload: unknown): VSleepSessionReport {
  if (!isRecord(payload)) fail('$', 'expected object');

  const sessionId = payload['session_id'];
  requireNullableString(sessionId, 'session_id');

  if (!Array.isArray(payload['observations'])) fail('observations', 'expected array');
  payload['observations'].forEach(validateObservation);

  if (!Array.isArray(payload['classifications'])) fail('classifications', 'expected array');
  payload['classifications'].forEach(validateClassification);

  validateUptime(payload['uptime']);

  // `recording` is optional only for legacy reports created before the backend
  // exposed first-class recording integrity. If present, it is authoritative and
  // therefore validated more strictly than forward-compatible raw evidence rows.
  if (payload['recording'] !== undefined) {
    validateRecording(payload['recording'], sessionId);
  }

  return payload as unknown as VSleepSessionReport;
}
