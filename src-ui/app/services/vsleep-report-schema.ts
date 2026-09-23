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

function fail(path: string, detail: string): never {
  throw new Error(`Invalid VSleep session report payload at ${path}: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string') fail(path, 'expected string');
}

function requireNullableString(value: unknown, path: string): asserts value is string | null {
  if (value !== null && typeof value !== 'string') fail(path, 'expected string or null');
}

function requireNonNegativeNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(path, 'expected finite non-negative number');
  }
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

function validateClassification(value: unknown, index: number): void {
  const path = `classifications[${index}]`;
  if (!isRecord(value)) fail(path, 'expected object');
  requireString(value['timestamp_utc'], `${path}.timestamp_utc`);
  requireString(value['category'], `${path}.category`);
  requireString(value['confidence'], `${path}.confidence`);
  requireString(value['rationale'], `${path}.rationale`);
  if (!Array.isArray(value['evidence'])) fail(`${path}.evidence`, 'expected array');
  value['evidence'].forEach((entry, evidenceIndex) =>
    requireString(entry, `${path}.evidence[${evidenceIndex}]`)
  );
}

function validateRuntimeUptime(value: unknown, path: string): void {
  if (!isRecord(value)) fail(path, 'expected object');
  requireNonNegativeNumber(value['observed_up_ms'], `${path}.observed_up_ms`);
  requireNonNegativeNumber(value['observed_down_ms'], `${path}.observed_down_ms`);
  requireNonNegativeNumber(value['unknown_ms'], `${path}.unknown_ms`);
  requireNonNegativeNumber(value['transitions'], `${path}.transitions`);
}

function validateUptime(value: unknown): void {
  if (!isRecord(value)) fail('uptime', 'expected object');
  const observedWindow = value['observed_window_ms'];
  if (observedWindow !== null) {
    requireNonNegativeNumber(observedWindow, 'uptime.observed_window_ms');
  }
  validateRuntimeUptime(value['hmd'], 'uptime.hmd');
  validateRuntimeUptime(value['steamvr'], 'uptime.steamvr');
  validateRuntimeUptime(value['vrchat'], 'uptime.vrchat');
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
