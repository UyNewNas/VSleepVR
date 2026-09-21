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
});
