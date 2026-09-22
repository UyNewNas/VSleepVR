import { describe, expect, it } from 'vitest';
import { VSleepReportService, type VSleepSessionReport } from './vsleep-report.service';

function reportFixture(): VSleepSessionReport {
  return {
    session_id: 'session-a',
    observations: [
      {
        schema_version: 1,
        timestamp_utc: '2026-09-21T02:41:00.000Z',
        session_id: 'session-a',
        source: 'open_vr',
        kind: 'hmd_disconnected',
        confidence: 'observed',
      },
    ],
    classifications: [
      {
        timestamp_utc: '2026-09-21T02:41:00.000Z',
        category: 'hmd_or_link_failure',
        confidence: 'inferred_medium',
        evidence: ['hmd_disconnected'],
        rationale: 'test fixture',
      },
    ],
    uptime: {
      observed_window_ms: 0,
      hmd: { observed_up_ms: 0, observed_down_ms: 0, unknown_ms: 0, transitions: 0 },
      steamvr: { observed_up_ms: 0, observed_down_ms: 0, unknown_ms: 0, transitions: 0 },
      vrchat: { observed_up_ms: 0, observed_down_ms: 0, unknown_ms: 0, transitions: 0 },
    },
  };
}

describe('VSleepReportService malformed timestamp guards', () => {
  it('keeps malformed timeline evidence visible but outside chronological ordering', () => {
    const report = reportFixture();
    report.observations.unshift({
      schema_version: 1,
      timestamp_utc: 'not-a-timestamp',
      session_id: 'session-a',
      source: 'open_vr',
      kind: 'hmd_connected',
      confidence: 'observed',
    });

    const entries = new VSleepReportService().toTimelineEntries(report);

    expect(entries).toHaveLength(3);
    expect(entries.at(-1)?.timestampUtc).toBe('not-a-timestamp');
    expect(entries.at(-1)?.entryType).toBe('observation');
  });

  it('does not close an interruption from an observed recovery with a malformed timestamp', () => {
    const report = reportFixture();
    report.observations.push({
      schema_version: 1,
      timestamp_utc: 'not-a-timestamp',
      session_id: 'session-a',
      source: 'open_vr',
      kind: 'hmd_connected',
      confidence: 'observed',
    });

    const incidents = new VSleepReportService().toIncidentWindows(report);

    expect(incidents).toHaveLength(1);
    expect(incidents[0].endTimestampUtc).toBeNull();
    expect(incidents[0].durationMs).toBeNull();
    expect(incidents[0].recoveryObservation).toBeNull();
  });

  it('does not create an interruption window from a malformed classification timestamp', () => {
    const report = reportFixture();
    report.classifications[0] = {
      ...report.classifications[0],
      timestamp_utc: 'not-a-timestamp',
    };

    expect(new VSleepReportService().toIncidentWindows(report)).toEqual([]);
  });
});
