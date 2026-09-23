import { describe, expect, it, vi } from 'vitest';
import { VSleepReportIntegrityError } from './vsleep-report-schema';
import { VSleepReportService } from './vsleep-report.service';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

function payloadWithForgedTrigger(): Record<string, unknown> {
  return {
    session_id: 'session-a',
    observations: [
      {
        schema_version: 1,
        timestamp_utc: '2026-09-21T02:41:00.000Z',
        session_id: 'session-a',
        source: 'vrchat_log',
        kind: 'hmd_disconnected',
        confidence: 'observed',
      },
    ],
    classifications: [
      {
        timestamp_utc: '2026-09-21T02:41:00.000Z',
        category: 'hmd_or_link_failure',
        confidence: 'inferred_medium',
        evidence: ['hmd_disconnected', 'steam_vr_started', 'vrchat_started'],
        rationale: 'backend-owned reliability classification',
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

function payloadWithOutOfBoundsClassification(): Record<string, unknown> {
  return {
    session_id: 'session-a',
    recording: {
      status: 'missing_end',
      start_timestamp_utc: '2026-09-21T02:42:00.000Z',
      end_timestamp_utc: null,
    },
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
        evidence: ['hmd_disconnected', 'steam_vr_started', 'vrchat_started'],
        rationale: 'backend-owned reliability classification',
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

function payloadWithCompleteWindowMismatch(): Record<string, unknown> {
  return {
    session_id: 'session-a',
    recording: {
      status: 'complete',
      start_timestamp_utc: '2026-09-21T02:40:00.000Z',
      end_timestamp_utc: '2026-09-21T02:42:00.000Z',
    },
    observations: [
      {
        schema_version: 1,
        timestamp_utc: '2026-09-21T02:40:00.000Z',
        session_id: 'session-a',
        source: 'vsleep',
        kind: 'session_started',
        confidence: 'observed',
      },
      {
        schema_version: 1,
        timestamp_utc: '2026-09-21T02:42:00.000Z',
        session_id: 'session-a',
        source: 'vsleep',
        kind: 'session_ended',
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

describe('VSleep report provenance at the Tauri boundary', () => {
  it('rejects a structurally valid classification whose raw trigger is not authoritative', async () => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(payloadWithForgedTrigger());
    const service = new VSleepReportService();

    await expect(service.readSessionReport('session-a.jsonl')).rejects.toMatchObject({
      name: 'VSleepReportIntegrityError',
      path: 'classifications[0].evidence[0]',
      detail:
        'missing authoritative observed trigger open_vr/hmd_disconnected at classification timestamp',
    } satisfies Partial<VSleepReportIntegrityError>);
  });

  it('rejects an authoritative trigger when its derived classification falls outside recording bounds', async () => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(payloadWithOutOfBoundsClassification());
    const service = new VSleepReportService();

    await expect(service.readSessionReport('session-a.jsonl')).rejects.toMatchObject({
      name: 'VSleepReportIntegrityError',
      path: 'classifications[0].timestamp_utc',
      detail: 'derived classification precedes authoritative recording start',
    } satisfies Partial<VSleepReportIntegrityError>);
  });

  it('rejects a complete report whose uptime window disagrees with its authoritative bounds', async () => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(payloadWithCompleteWindowMismatch());
    const service = new VSleepReportService();

    await expect(service.readSessionReport('session-a.jsonl')).rejects.toMatchObject({
      name: 'VSleepReportIntegrityError',
      path: 'uptime.observed_window_ms',
      detail: 'complete recording requires observed window to equal authoritative bounds (120000)',
    } satisfies Partial<VSleepReportIntegrityError>);
  });
});
