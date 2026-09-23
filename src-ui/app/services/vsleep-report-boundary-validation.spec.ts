import { describe, expect, it, vi } from 'vitest';
import { VSleepReportService } from './vsleep-report.service';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

function basePayload() {
  return {
    session_id: 'session-a',
    observations: [],
    classifications: [],
    uptime: {
      observed_window_ms: null,
      hmd: { observed_up_ms: 0, observed_down_ms: 0, unknown_ms: 0, transitions: 0 },
      steamvr: { observed_up_ms: 0, observed_down_ms: 0, unknown_ms: 0, transitions: 0 },
      vrchat: { observed_up_ms: 0, observed_down_ms: 0, unknown_ms: 0, transitions: 0 },
    },
  };
}

describe('VSleepReportService Tauri payload boundary', () => {
  it('rejects contradictory authoritative recording metadata before UI adapters see it', async () => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue({
      ...basePayload(),
      recording: {
        status: 'complete',
        start_timestamp_utc: '2026-09-20T23:48:00.000Z',
        end_timestamp_utc: null,
      },
    });

    await expect(new VSleepReportService().readSessionReport('session-a.jsonl')).rejects.toThrow(
      /complete requires ordered start and end timestamps/
    );
    expect(mocks.invoke).toHaveBeenCalledWith('vsleep_read_session_report', {
      fileName: 'session-a.jsonl',
    });
  });

  it('rejects structurally malformed rows instead of deferring failure into timeline rendering', async () => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue({
      ...basePayload(),
      observations: [null],
    });

    await expect(new VSleepReportService().readSessionReport('session-a.jsonl')).rejects.toThrow(
      /observations\[0\]: expected object/
    );
  });
});
