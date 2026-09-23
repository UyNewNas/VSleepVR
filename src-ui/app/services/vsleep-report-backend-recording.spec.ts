import { describe, expect, it } from 'vitest';
import {
  VSleepReportService,
  type VSleepFailureClassification,
  type VSleepSessionEvent,
  type VSleepSessionReport,
} from './vsleep-report.service';

const uptime = {
  observed_window_ms: null,
  hmd: { observed_up_ms: 0, observed_down_ms: 0, unknown_ms: 0, transitions: 0 },
  steamvr: { observed_up_ms: 0, observed_down_ms: 0, unknown_ms: 0, transitions: 0 },
  vrchat: { observed_up_ms: 0, observed_down_ms: 0, unknown_ms: 0, transitions: 0 },
};

function boundary(
  kind: 'session_started' | 'session_ended',
  timestampUtc: string,
  sessionId = 'session-a'
): VSleepSessionEvent {
  return {
    schema_version: 1,
    timestamp_utc: timestampUtc,
    session_id: sessionId,
    source: 'vsleep',
    kind,
    confidence: 'observed',
  };
}

function classification(timestampUtc: string): VSleepFailureClassification {
  return {
    timestamp_utc: timestampUtc,
    category: 'hmd_or_link_failure',
    confidence: 'inferred_medium',
    evidence: ['hmd_disconnected', 'steam_vr_started', 'vrchat_started'],
    rationale: 'fixture',
  };
}

describe('VSleepReportService backend recording summary', () => {
  it('uses the backend recording summary instead of re-deriving newer reports from raw rows', () => {
    const report: VSleepSessionReport = {
      session_id: 'session-a',
      recording: {
        status: 'missing_end',
        start_timestamp_utc: '2026-09-20T23:48:00.000Z',
        end_timestamp_utc: null,
      },
      // Legacy frontend derivation would call this complete. The backend-owned
      // summary must win so classifier/uptime/UI share one boundary contract.
      observations: [
        boundary('session_started', '2026-09-20T23:48:00.000Z'),
        boundary('session_ended', '2026-09-21T07:31:00.000Z'),
      ],
      classifications: [],
      uptime,
    };

    expect(new VSleepReportService().summarizeSessionBoundaries(report)).toEqual({
      status: 'missing_end',
      startTimestampUtc: '2026-09-20T23:48:00.000Z',
      endTimestampUtc: null,
    });
  });

  it('keeps the raw-observation derivation as a compatibility fallback for older reports', () => {
    const report: VSleepSessionReport = {
      session_id: 'session-a',
      observations: [
        boundary('session_started', '2026-09-20T23:48:00.000Z'),
        boundary('session_ended', '2026-09-21T07:31:00.000Z'),
      ],
      classifications: [],
      uptime,
    };

    expect(new VSleepReportService().summarizeSessionBoundaries(report).status).toBe('complete');
  });

  it('fails closed for backend-declared mixed-session input while keeping raw evidence visible', () => {
    const report: VSleepSessionReport = {
      session_id: null,
      recording: {
        status: 'ambiguous_session',
        start_timestamp_utc: null,
        end_timestamp_utc: null,
      },
      observations: [
        boundary('session_started', '2026-09-20T23:48:00.000Z', 'session-a'),
        boundary('session_started', '2026-09-20T23:49:00.000Z', 'session-b'),
      ],
      // Backend mixed-session reports are expected to have no derived rows. If a
      // stale/corrupt payload contains one anyway, the frontend must not revive it.
      classifications: [classification('2026-09-21T02:41:00.000Z')],
      uptime,
    };

    const service = new VSleepReportService();
    const timeline = service.toTimelineEntries(report);

    expect(timeline.filter((entry) => entry.entryType === 'observation')).toHaveLength(2);
    expect(timeline.filter((entry) => entry.entryType === 'classification')).toHaveLength(0);
    expect(service.toIncidentWindows(report)).toEqual([]);
  });
});
