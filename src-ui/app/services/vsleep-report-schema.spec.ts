import { describe, expect, it } from 'vitest';
import {
  parseVSleepSessionReport,
  VSleepReportIntegrityError,
} from './vsleep-report-schema';

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

function classification(
  category: string,
  confidence: string,
  evidence: string[]
): Record<string, unknown> {
  return {
    timestamp_utc: '2026-09-21T00:10:00.000Z',
    category,
    confidence,
    evidence,
    rationale: 'backend-owned reliability classification',
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

  it('accepts the current backend classification category/confidence/evidence contracts', () => {
    const payload = validPayload();
    payload.classifications = [
      classification('hmd_or_link_failure', 'inferred_medium', [
        'hmd_disconnected',
        'steam_vr_started',
        'vrchat_started',
      ]),
      classification('steam_vr_failure', 'inferred_medium', [
        'steam_vr_stopped',
        'vrchat_started',
      ]),
      classification('vrchat_failure', 'inferred_medium', [
        'vrchat_stopped',
        'steam_vr_started',
      ]),
      classification('windows_power_transition', 'observed', ['windows_suspend']),
      classification('unknown_insufficient_evidence', 'inferred_low', ['hmd_disconnected']),
    ];

    expect(parseVSleepSessionReport(payload)).toBe(payload);
  });

  it('fails closed on an unknown derived classification category', () => {
    const payload = validPayload();
    payload.classifications = [classification('future_failure', 'inferred_medium', ['hmd_disconnected'])];
    expect(() => parseVSleepSessionReport(payload)).toThrow(
      /classifications\[0\]\.category: unknown category future_failure/
    );
  });

  it('rejects a derived classification with an unparseable timestamp', () => {
    const payload = validPayload();
    const derived = classification('hmd_or_link_failure', 'inferred_medium', [
      'hmd_disconnected',
      'steam_vr_started',
      'vrchat_started',
    ]);
    derived['timestamp_utc'] = 'not-a-timestamp';
    payload.classifications = [derived];

    expect(() => parseVSleepSessionReport(payload)).toThrow(
      /classifications\[0\]\.timestamp_utc: expected parseable timestamp/
    );
  });

  it('rejects a category/confidence pairing the backend does not emit', () => {
    const payload = validPayload();
    payload.classifications = [
      classification('steam_vr_failure', 'observed', ['steam_vr_stopped', 'vrchat_started']),
    ];
    expect(() => parseVSleepSessionReport(payload)).toThrow(
      /classifications\[0\]\.confidence: steam_vr_failure requires inferred_medium/
    );
  });

  it('rejects a category/evidence sequence the backend does not emit', () => {
    const payload = validPayload();
    payload.classifications = [
      classification('vrchat_failure', 'inferred_medium', ['vrchat_stopped', 'vrchat_started']),
    ];
    expect(() => parseVSleepSessionReport(payload)).toThrow(
      /classifications\[0\]\.evidence: expected backend evidence sequence vrchat_stopped, steam_vr_started/
    );
  });

  it('rejects future enum values inside backend-owned derived evidence', () => {
    const payload = validPayload();
    payload.classifications = [
      classification('unknown_insufficient_evidence', 'inferred_low', ['future_failure_signal']),
    ];
    expect(() => parseVSleepSessionReport(payload)).toThrow(
      /classifications\[0\]\.evidence\[0\]: unknown derived evidence kind future_failure_signal/
    );
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

  it('exposes schema failures as a distinct integrity error for read-only UI handling', () => {
    const payload = validPayload();
    payload.recording = {
      status: 'complete',
      start_timestamp_utc: '2026-09-20T23:48:00.000Z',
      end_timestamp_utc: null,
    };

    try {
      parseVSleepSessionReport(payload);
      throw new Error('fixture should have failed validation');
    } catch (error) {
      expect(error).toBeInstanceOf(VSleepReportIntegrityError);
      expect(error).toMatchObject({
        name: 'VSleepReportIntegrityError',
        path: 'recording',
        detail: 'complete requires ordered start and end timestamps',
      });
    }
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

  it('rejects uptime durations that do not partition the observed window', () => {
    const payload = validPayload();
    (payload.uptime['hmd'] as Record<string, unknown>)['unknown_ms'] = 59_999;
    expect(() => parseVSleepSessionReport(payload)).toThrow(
      /uptime\.hmd: runtime durations must sum to observed_window_ms \(60000\)/
    );
  });

  it('requires a null observed window to carry only the backend default runtime summaries', () => {
    const payload = validPayload();
    payload.uptime['observed_window_ms'] = null;
    expect(() => parseVSleepSessionReport(payload)).toThrow(
      /uptime\.hmd: expected zero runtime summary when observed_window_ms is null/
    );
  });

  it('rejects fractional runtime transition counts', () => {
    const payload = validPayload();
    (payload.uptime['hmd'] as Record<string, unknown>)['transitions'] = 0.5;
    expect(() => parseVSleepSessionReport(payload)).toThrow(
      /uptime\.hmd\.transitions: expected non-negative safe integer/
    );
  });
});
