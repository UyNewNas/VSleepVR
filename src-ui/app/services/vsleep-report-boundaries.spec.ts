import { describe, expect, it } from 'vitest';
import {
  VSleepReportService,
  type VSleepSessionEvent,
  type VSleepSessionReport,
} from './vsleep-report.service';

function observation(
  kind: VSleepSessionEvent['kind'],
  timestampUtc: string,
  confidence: VSleepSessionEvent['confidence'] = 'observed',
  sessionId = 'session-a'
): VSleepSessionEvent {
  return {
    schema_version: 1,
    timestamp_utc: timestampUtc,
    session_id: sessionId,
    source: 'vsleep',
    kind,
    confidence,
  };
}

function report(observations: VSleepSessionEvent[]): VSleepSessionReport {
  return {
    session_id: 'session-a',
    observations,
    classifications: [],
    uptime: {
      observed_window_ms: null,
      hmd: { observed_up_ms: 0, observed_down_ms: 0, unknown_ms: 0, transitions: 0 },
      steamvr: { observed_up_ms: 0, observed_down_ms: 0, unknown_ms: 0, transitions: 0 },
      vrchat: { observed_up_ms: 0, observed_down_ms: 0, unknown_ms: 0, transitions: 0 },
    },
  };
}

describe('VSleepReportService session boundaries', () => {
  it('marks a recording complete only with observed start and end boundaries', () => {
    const service = new VSleepReportService();
    const summary = service.summarizeSessionBoundaries(
      report([
        observation('session_ended', '2026-09-21T07:31:00.000Z'),
        observation('session_started', '2026-09-20T23:48:00.000Z'),
      ])
    );

    expect(summary).toEqual({
      status: 'complete',
      startTimestampUtc: '2026-09-20T23:48:00.000Z',
      endTimestampUtc: '2026-09-21T07:31:00.000Z',
    });
  });

  it('ignores inferred or foreign-session boundaries instead of treating them as proof', () => {
    const service = new VSleepReportService();
    const summary = service.summarizeSessionBoundaries(
      report([
        observation('session_started', '2026-09-20T23:48:00.000Z'),
        observation('session_ended', '2026-09-21T07:31:00.000Z', 'inferred_high'),
        observation('session_ended', '2026-09-21T07:32:00.000Z', 'observed', 'session-b'),
      ])
    );

    expect(summary).toEqual({
      status: 'missing_end',
      startTimestampUtc: '2026-09-20T23:48:00.000Z',
      endTimestampUtc: null,
    });
  });

  it('ignores malformed boundaries instead of treating them as completeness evidence', () => {
    const service = new VSleepReportService();
    const summary = service.summarizeSessionBoundaries(
      report([
        observation('session_started', 'not-a-timestamp'),
        observation('session_ended', '2026-09-21T07:31:00.000Z'),
      ])
    );

    expect(summary).toEqual({
      status: 'missing_start',
      startTimestampUtc: null,
      endTimestampUtc: '2026-09-21T07:31:00.000Z',
    });
  });

  it('lets valid observed boundaries prove completeness despite malformed boundary noise', () => {
    const service = new VSleepReportService();
    const summary = service.summarizeSessionBoundaries(
      report([
        observation('session_started', 'not-a-timestamp'),
        observation('session_ended', 'also-not-a-timestamp'),
        observation('session_ended', '2026-09-21T07:31:00.000Z'),
        observation('session_started', '2026-09-20T23:48:00.000Z'),
      ])
    );

    expect(summary).toEqual({
      status: 'complete',
      startTimestampUtc: '2026-09-20T23:48:00.000Z',
      endTimestampUtc: '2026-09-21T07:31:00.000Z',
    });
  });

  it('keeps reversed observed boundaries visibly invalid rather than calling them complete', () => {
    const service = new VSleepReportService();
    const summary = service.summarizeSessionBoundaries(
      report([
        observation('session_ended', '2026-09-20T23:47:00.000Z'),
        observation('session_started', '2026-09-20T23:48:00.000Z'),
      ])
    );

    expect(summary.status).toBe('invalid_order');
    expect(summary.startTimestampUtc).toBe('2026-09-20T23:48:00.000Z');
    expect(summary.endTimestampUtc).toBe('2026-09-20T23:47:00.000Z');
  });
});
