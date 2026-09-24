import { describe, expect, it, vi } from 'vitest';
import {
  VSleepReportService,
  type VSleepSessionReport,
} from './vsleep-report.service';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

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
      {
        schema_version: 1,
        timestamp_utc: '2026-09-21T02:42:00.000Z',
        session_id: 'session-a',
        source: 'vrchat_process',
        kind: 'vrchat_started',
        confidence: 'observed',
      },
    ],
    classifications: [
      {
        timestamp_utc: '2026-09-21T02:41:00.000Z',
        category: 'hmd_or_link_failure',
        confidence: 'inferred_medium',
        evidence: ['hmd_disconnected', 'steam_vr_started', 'vrchat_started'],
        rationale: 'Observed HMD disconnect while both peer runtimes remained available.',
      },
    ],
    uptime: {
      observed_window_ms: 60_000,
      hmd: {
        observed_up_ms: 0,
        observed_down_ms: 60_000,
        unknown_ms: 0,
        transitions: 0,
      },
      steamvr: {
        observed_up_ms: 60_000,
        observed_down_ms: 0,
        unknown_ms: 0,
        transitions: 0,
      },
      vrchat: {
        observed_up_ms: 0,
        observed_down_ms: 0,
        unknown_ms: 60_000,
        transitions: 0,
      },
    },
  };
}

describe('VSleepReportService', () => {
  it('lists persisted sessions through the read-only Tauri command', async () => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue([
      {
        file_name: 'session-a.jsonl',
        size_bytes: 128,
        modified_utc: '2026-09-21T07:31:00.000Z',
      },
    ]);
    const service = new VSleepReportService();

    await expect(service.listSessions()).resolves.toEqual([
      {
        file_name: 'session-a.jsonl',
        size_bytes: 128,
        modified_utc: '2026-09-21T07:31:00.000Z',
      },
    ]);
    expect(mocks.invoke).toHaveBeenCalledWith('vsleep_list_sessions');
  });

  it('loads a persisted report through the read-only Tauri command', async () => {
    const report = reportFixture();
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(report);
    const service = new VSleepReportService();

    await expect(service.readSessionReport('session-a.jsonl')).resolves.toEqual(report);
    expect(mocks.invoke).toHaveBeenCalledWith('vsleep_read_session_report', {
      fileName: 'session-a.jsonl',
    });
  });

  it('loads the newest persisted session without guessing a filename', async () => {
    const report = reportFixture();
    mocks.invoke.mockReset();
    mocks.invoke
      .mockResolvedValueOnce([
        {
          file_name: 'session-a.jsonl',
          size_bytes: 128,
          modified_utc: '2026-09-21T07:31:00.000Z',
        },
      ])
      .mockResolvedValueOnce(report);
    const service = new VSleepReportService();

    await expect(service.readLatestSessionReport()).resolves.toEqual(report);
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'vsleep_list_sessions');
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'vsleep_read_session_report', {
      fileName: 'session-a.jsonl',
    });
  });

  it('returns null when no persisted session exists', async () => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue([]);
    const service = new VSleepReportService();

    await expect(service.readLatestSessionReport()).resolves.toBeNull();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith('vsleep_list_sessions');
  });

  it('keeps observations visually separable from classifications in chronological order', () => {
    const report = reportFixture();
    const service = new VSleepReportService();

    const entries = service.toTimelineEntries(report);

    expect(entries.map((entry) => entry.entryType)).toEqual([
      'observation',
      'classification',
      'observation',
    ]);
    expect(entries[0].timestampUtc).toBe('2026-09-21T02:41:00.000Z');
    expect(report.observations).toHaveLength(2);
    expect(report.classifications).toHaveLength(1);
  });

  it('groups an inferred interruption until an observed recovery without inventing recovery', () => {
    const report = reportFixture();
    report.classifications.push({
      ...report.classifications[0],
      timestamp_utc: '2026-09-21T02:42:00.000Z',
    });
    report.observations.push({
      schema_version: 1,
      timestamp_utc: '2026-09-21T02:47:00.000Z',
      session_id: 'session-a',
      source: 'open_vr',
      kind: 'hmd_connected',
      confidence: 'observed',
    });
    const service = new VSleepReportService();

    const incidents = service.toIncidentWindows(report);

    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      category: 'hmd_or_link_failure',
      confidence: 'inferred_medium',
      startTimestampUtc: '2026-09-21T02:41:00.000Z',
      endTimestampUtc: '2026-09-21T02:47:00.000Z',
      durationMs: 360_000,
    });
    expect(incidents[0].recoveryObservation?.kind).toBe('hmd_connected');
    expect(incidents[0].recoveryObservation?.confidence).toBe('observed');
  });

  it('does not close an interruption from inferred recovery evidence', () => {
    const report = reportFixture();
    report.observations.push({
      schema_version: 1,
      timestamp_utc: '2026-09-21T02:47:00.000Z',
      session_id: 'session-a',
      source: 'open_vr',
      kind: 'hmd_connected',
      confidence: 'inferred_low',
    });
    const service = new VSleepReportService();

    const incidents = service.toIncidentWindows(report);

    expect(incidents).toHaveLength(1);
    expect(incidents[0].endTimestampUtc).toBeNull();
    expect(incidents[0].durationMs).toBeNull();
    expect(incidents[0].recoveryObservation).toBeNull();
  });

  it('does not close an interruption from another session recovery observation', () => {
    const report = reportFixture();
    report.observations.push({
      schema_version: 1,
      timestamp_utc: '2026-09-21T02:47:00.000Z',
      session_id: 'session-b',
      source: 'open_vr',
      kind: 'hmd_connected',
      confidence: 'observed',
    });
    const service = new VSleepReportService();

    const incidents = service.toIncidentWindows(report);

    expect(incidents).toHaveLength(1);
    expect(incidents[0].endTimestampUtc).toBeNull();
    expect(incidents[0].durationMs).toBeNull();
    expect(incidents[0].recoveryObservation).toBeNull();
  });

  it('requires an authoritative source before an observed recovery can close an incident', () => {
    const cases = [
      {
        category: 'hmd_or_link_failure',
        kind: 'hmd_connected',
        forgedSource: 'vrchat_log',
        authoritativeSource: 'open_vr',
      },
      {
        category: 'steam_vr_failure',
        kind: 'steam_vr_started',
        forgedSource: 'open_vr',
        authoritativeSource: 'steam_vr',
      },
      {
        category: 'vrchat_failure',
        kind: 'vrchat_started',
        forgedSource: 'vrchat_log',
        authoritativeSource: 'vrchat_process',
      },
    ] as const;
    const service = new VSleepReportService();

    for (const recoveryCase of cases) {
      const report = reportFixture();
      report.classifications = [
        {
          ...report.classifications[0],
          category: recoveryCase.category,
        },
      ];
      report.observations = [
        {
          schema_version: 1,
          timestamp_utc: '2026-09-21T02:47:00.000Z',
          session_id: 'session-a',
          source: recoveryCase.forgedSource,
          kind: recoveryCase.kind,
          confidence: 'observed',
        },
        {
          schema_version: 1,
          timestamp_utc: '2026-09-21T02:48:00.000Z',
          session_id: 'session-a',
          source: recoveryCase.authoritativeSource,
          kind: recoveryCase.kind,
          confidence: 'observed',
        },
      ];

      const incidents = service.toIncidentWindows(report);

      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        category: recoveryCase.category,
        startTimestampUtc: '2026-09-21T02:41:00.000Z',
        endTimestampUtc: '2026-09-21T02:48:00.000Z',
        durationMs: 420_000,
      });
      expect(incidents[0].recoveryObservation?.source).toBe(recoveryCase.authoritativeSource);
      expect(incidents[0].recoveryObservation?.kind).toBe(recoveryCase.kind);
    }
  });

  it('leaves an interruption open when no recovery observation exists', () => {
    const service = new VSleepReportService();

    const incidents = service.toIncidentWindows(reportFixture());

    expect(incidents).toHaveLength(1);
    expect(incidents[0].endTimestampUtc).toBeNull();
    expect(incidents[0].durationMs).toBeNull();
    expect(incidents[0].recoveryObservation).toBeNull();
  });
});
