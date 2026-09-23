import { describe, expect, it } from 'vitest';
import { parseVSleepSessionReport } from './vsleep-report-schema';

interface MutableReportPayload {
  session_id: string | null;
  recording: {
    status: string;
    start_timestamp_utc: string | null;
    end_timestamp_utc: string | null;
  };
  observations: Array<{
    schema_version: number;
    timestamp_utc: string;
    session_id: string;
    source: string;
    kind: string;
    confidence: string;
  }>;
  classifications: unknown[];
  uptime: Record<string, unknown>;
}

function validPayload(): MutableReportPayload {
  return {
    session_id: 'session-a',
    recording: {
      status: 'missing_end',
      start_timestamp_utc: '2026-09-20T23:48:00.000Z',
      end_timestamp_utc: null,
    },
    observations: [
      {
        schema_version: 1,
        timestamp_utc: '2026-09-20T23:48:00.000Z',
        session_id: 'session-a',
        source: 'vsleep',
        kind: 'session_started',
        confidence: 'observed',
      },
    ],
    classifications: [],
    uptime: {
      observed_window_ms: 60_000,
      hmd: { observed_up_ms: 0, observed_down_ms: 0, unknown_ms: 60_000, transitions: 0 },
      steamvr: { observed_up_ms: 0, observed_down_ms: 0, unknown_ms: 60_000, transitions: 0 },
      vrchat: { observed_up_ms: 0, observed_down_ms: 0, unknown_ms: 60_000, transitions: 0 },
    },
  };
}

describe('VSleep session report runtime schema', () => {
  it('accepts a current backend report', () => {
    const payload = validPayload();
    expect(parseVSleepSessionReport(payload)).toBe(payload);
  });

  it('keeps legacy reports without recording metadata readable', () => {
    const payload = validPayload();
    delete (payload as { recording?: unknown }).recording;
    expect(parseVSleepSessionReport(payload)).toBe(payload);
  });

  it('keeps raw evidence enums forward-compatible while validating their shape', () => {
    const payload = validPayload();
    payload.observations[0].source = 'future_observer';
    payload.observations[0].kind = 'future_observation';
    expect(parseVSleepSessionReport(payload)).toBe(payload);
  });

  it('fails closed on an unknown authoritative recording status', () => {
    const payload = validPayload();
    payload.recording.status = 'future_status';
    expect(() => parseVSleepSessionReport(payload)).toThrow(/recording\.status: unknown status/);
  });

  it('rejects a contradictory complete recording before the UI trusts its bounds', () => {
    const payload = validPayload();
    payload.recording = {
      status: 'complete',
      start_timestamp_utc: '2026-09-20T23:48:00.000Z',
      end_timestamp_utc: null,
    };
    expect(() => parseVSleepSessionReport(payload)).toThrow(
      /complete requires ordered start and end timestamps/
    );
  });

  it('rejects a mixed-session status that still claims one session id', () => {
    const payload = validPayload();
    payload.recording = {
      status: 'ambiguous_session',
      start_timestamp_utc: null,
      end_timestamp_utc: null,
    };
    expect(() => parseVSleepSessionReport(payload)).toThrow(
      /ambiguous_session requires null session_id and boundaries/
    );
  });

  it('rejects structurally invalid raw rows instead of crashing later adapters', () => {
    const payload = validPayload();
    (payload.observations as unknown[]) = [null];
    expect(() => parseVSleepSessionReport(payload)).toThrow(/observations\[0\]: expected object/);
  });
});
