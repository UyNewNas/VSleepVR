import { describe, expect, it } from 'vitest';
import {
  VSleepReportService,
  type VSleepFailureClassification,
  type VSleepSessionEvent,
  type VSleepSessionReport,
} from './vsleep-report.service';

function observation(kind: VSleepSessionEvent['kind'], timestampUtc: string): VSleepSessionEvent {
  return {
    schema_version: 1,
    timestamp_utc: timestampUtc,
    session_id: 'session-a',
    source: kind.startsWith('hmd_') ? 'open_vr' : 'vsleep',
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

function reportFixture(): VSleepSessionReport {
  return {
    session_id: 'session-a',
    observations: [
      observation('session_started', '2026-09-20T23:48:00.000Z'),
      observation('session_ended', '2026-09-21T07:31:00.000Z'),
    ],
    classifications: [],
    uptime: {
      observed_window_ms: 27_780_000,
      hmd: { observed_up_ms: 0, observed_down_ms: 0, unknown_ms: 0, transitions: 0 },
      steamvr: { observed_up_ms: 0, observed_down_ms: 0, unknown_ms: 0, transitions: 0 },
      vrchat: { observed_up_ms: 0, observed_down_ms: 0, unknown_ms: 0, transitions: 0 },
    },
  };
}

describe('VSleepReportService recording-bounded incident windows', () => {
  it('quarantines classifications outside a complete observed session', () => {
    const report = reportFixture();
    report.classifications = [
      classification('2026-09-20T23:40:00.000Z'),
      classification('2026-09-21T02:41:00.000Z'),
      classification('2026-09-21T07:40:00.000Z'),
    ];

    const incidents = new VSleepReportService().toIncidentWindows(report);

    expect(incidents).toHaveLength(1);
    expect(incidents[0].startTimestampUtc).toBe('2026-09-21T02:41:00.000Z');
  });

  it('does not use a recovery observed after a complete session ended', () => {
    const report = reportFixture();
    report.classifications = [classification('2026-09-21T07:30:00.000Z')];
    report.observations.push(observation('hmd_connected', '2026-09-21T07:32:00.000Z'));

    const [incident] = new VSleepReportService().toIncidentWindows(report);

    expect(incident.endTimestampUtc).toBeNull();
    expect(incident.durationMs).toBeNull();
    expect(incident.recoveryObservation).toBeNull();
  });

  it('keeps valid incident evidence for a partial recording instead of inventing bounds', () => {
    const report = reportFixture();
    report.observations = [observation('session_started', '2026-09-20T23:48:00.000Z')];
    report.classifications = [classification('2026-09-21T08:00:00.000Z')];

    const incidents = new VSleepReportService().toIncidentWindows(report);

    expect(incidents).toHaveLength(1);
    expect(incidents[0].startTimestampUtc).toBe('2026-09-21T08:00:00.000Z');
  });
});
