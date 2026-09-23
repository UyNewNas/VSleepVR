import { describe, expect, it } from 'vitest';
import { validateVSleepClassificationProvenance } from './vsleep-report-provenance';
import { VSleepReportIntegrityError } from './vsleep-report-schema';
import type { VSleepSessionReport } from './vsleep-report.service';

function reportFixture(): VSleepSessionReport {
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
        timestamp_utc: '2026-09-21T02:41:00.000Z',
        session_id: 'session-a',
        source: 'open_vr',
        kind: 'hmd_disconnected',
        confidence: 'observed',
      },
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
      observed_window_ms: 120_000,
      hmd: { observed_up_ms: 0, observed_down_ms: 0, unknown_ms: 120_000, transitions: 0 },
      steamvr: { observed_up_ms: 0, observed_down_ms: 0, unknown_ms: 120_000, transitions: 0 },
      vrchat: { observed_up_ms: 0, observed_down_ms: 0, unknown_ms: 120_000, transitions: 0 },
    },
  };
}

function setUptimeWindow(report: VSleepSessionReport, observedWindowMs: number | null): void {
  report.uptime.observed_window_ms = observedWindowMs;
  const unknownMs = observedWindowMs ?? 0;
  report.uptime.hmd = { observed_up_ms: 0, observed_down_ms: 0, unknown_ms: unknownMs, transitions: 0 };
  report.uptime.steamvr = { observed_up_ms: 0, observed_down_ms: 0, unknown_ms: unknownMs, transitions: 0 };
  report.uptime.vrchat = { observed_up_ms: 0, observed_down_ms: 0, unknown_ms: unknownMs, transitions: 0 };
}

describe('VSleep derived classification provenance', () => {
  it('accepts a classification backed by its authoritative observed trigger and boundaries', () => {
    const report = reportFixture();
    expect(validateVSleepClassificationProvenance(report)).toBe(report);
  });

  it('keeps legacy reports without backend recording metadata compatible', () => {
    const report = reportFixture();
    delete report.recording;

    expect(validateVSleepClassificationProvenance(report)).toBe(report);
  });

  it('rejects a current report observation from another session even without classifications', () => {
    const report = reportFixture();
    report.classifications = [];
    report.observations.push({
      ...report.observations[0],
      session_id: 'session-b',
    });

    expect(() => validateVSleepClassificationProvenance(report)).toThrow(
      /observations\[3\]\.session_id: current backend report observations must match session_id/
    );
  });

  it('requires non-empty sessionless current reports to be marked ambiguous_session', () => {
    const report = reportFixture();
    report.session_id = null;
    report.classifications = [];
    report.recording = {
      status: 'missing_both',
      start_timestamp_utc: null,
      end_timestamp_utc: null,
    };
    setUptimeWindow(report, null);

    expect(() => validateVSleepClassificationProvenance(report)).toThrow(
      /recording\.status: sessionless report with mixed observations requires ambiguous_session/
    );
  });

  it('requires sessionless current reports to keep backend uptime quarantined', () => {
    const report = reportFixture();
    report.session_id = null;
    report.classifications = [];
    report.recording = {
      status: 'ambiguous_session',
      start_timestamp_utc: null,
      end_timestamp_utc: null,
    };
    setUptimeWindow(report, 0);

    expect(() => validateVSleepClassificationProvenance(report)).toThrow(
      /uptime\.observed_window_ms: sessionless reports require a null observed window/
    );
  });

  it('requires a complete recording uptime window to equal its authoritative bounds', () => {
    const report = reportFixture();
    report.classifications = [];
    setUptimeWindow(report, 60_000);

    expect(() => validateVSleepClassificationProvenance(report)).toThrow(
      /complete recording requires observed window to equal authoritative bounds \(120000\)/
    );
  });

  it('uses the first authoritative observation as the missing-start uptime fallback', () => {
    const report = reportFixture();
    report.classifications = [];
    report.observations[1].source = 'sleep_mode';
    report.recording = {
      status: 'missing_start',
      start_timestamp_utc: null,
      end_timestamp_utc: '2026-09-21T02:42:00.000Z',
    };
    setUptimeWindow(report, 60_000);

    expect(validateVSleepClassificationProvenance(report)).toBe(report);
  });

  it('rejects a missing-start uptime window stretched by non-authoritative evidence', () => {
    const report = reportFixture();
    report.classifications = [];
    report.observations[1].source = 'sleep_mode';
    report.recording = {
      status: 'missing_start',
      start_timestamp_utc: null,
      end_timestamp_utc: '2026-09-21T02:42:00.000Z',
    };

    expect(() => validateVSleepClassificationProvenance(report)).toThrow(
      /missing_start recording requires observed window to equal the backend authoritative-evidence window \(60000\)/
    );
  });

  it('uses the last authoritative observation as the missing-end uptime fallback', () => {
    const report = reportFixture();
    report.classifications = [];
    report.observations[2].source = 'sleep_mode';
    report.recording = {
      status: 'missing_end',
      start_timestamp_utc: '2026-09-21T02:40:00.000Z',
      end_timestamp_utc: null,
    };
    setUptimeWindow(report, 60_000);

    expect(validateVSleepClassificationProvenance(report)).toBe(report);
  });

  it('rejects a backend recording start that is not present as raw authoritative evidence', () => {
    const report = reportFixture();
    report.classifications = [];
    report.observations[1].source = 'sleep_mode';

    expect(() => validateVSleepClassificationProvenance(report)).toThrow(
      /recording\.start_timestamp_utc: backend recording start does not match raw authoritative boundary \(none\)/
    );
  });

  it('rejects a backend recording timestamp that disagrees with the unique raw boundary', () => {
    const report = reportFixture();
    report.classifications = [];
    report.recording = {
      status: 'complete',
      start_timestamp_utc: '2026-09-21T02:39:00.000Z',
      end_timestamp_utc: '2026-09-21T02:42:00.000Z',
    };
    setUptimeWindow(report, 180_000);

    expect(() => validateVSleepClassificationProvenance(report)).toThrow(
      /recording\.start_timestamp_utc: backend recording start does not match raw authoritative boundary \(2026-09-21T02:40:00.000Z\)/
    );
  });

  it('accepts ambiguous boundary metadata only when raw authoritative multiplicity supports it', () => {
    const report = reportFixture();
    report.classifications = [];
    report.observations.push({
      ...report.observations[1],
      timestamp_utc: '2026-09-21T02:40:30.000Z',
    });
    report.recording = {
      status: 'ambiguous_boundaries',
      start_timestamp_utc: null,
      end_timestamp_utc: '2026-09-21T02:42:00.000Z',
    };

    expect(validateVSleepClassificationProvenance(report)).toBe(report);
  });

  it('rejects a derived classification before a trustworthy recording start', () => {
    const report = reportFixture();
    report.recording = {
      status: 'missing_end',
      start_timestamp_utc: '2026-09-21T02:42:00.000Z',
      end_timestamp_utc: null,
    };
    report.observations[1].timestamp_utc = '2026-09-21T02:42:00.000Z';
    report.observations[2].source = 'sleep_mode';
    setUptimeWindow(report, 0);

    expect(() => validateVSleepClassificationProvenance(report)).toThrow(
      /derived classification precedes authoritative recording start/
    );
  });

  it('rejects a derived classification after a trustworthy recording end', () => {
    const report = reportFixture();
    report.recording = {
      status: 'missing_start',
      start_timestamp_utc: null,
      end_timestamp_utc: '2026-09-21T02:40:00.000Z',
    };
    report.observations[1].source = 'sleep_mode';
    report.observations[2].timestamp_utc = '2026-09-21T02:40:00.000Z';
    setUptimeWindow(report, 0);

    expect(() => validateVSleepClassificationProvenance(report)).toThrow(
      /derived classification follows authoritative recording end/
    );
  });

  it('uses a retained one-sided edge when the opposite recording boundary is ambiguous', () => {
    const report = reportFixture();
    report.recording = {
      status: 'ambiguous_boundaries',
      start_timestamp_utc: '2026-09-21T02:42:00.000Z',
      end_timestamp_utc: null,
    };
    report.observations[1].timestamp_utc = '2026-09-21T02:42:00.000Z';
    report.observations[2].timestamp_utc = '2026-09-21T02:43:00.000Z';
    report.observations.push({
      ...report.observations[2],
      timestamp_utc: '2026-09-21T02:44:00.000Z',
    });

    expect(() => validateVSleepClassificationProvenance(report)).toThrow(
      /derived classification precedes authoritative recording start/
    );
  });

  it('does not invent usable bounds for an invalid-order recording', () => {
    const report = reportFixture();
    report.recording = {
      status: 'invalid_order',
      start_timestamp_utc: '2026-09-21T03:00:00.000Z',
      end_timestamp_utc: '2026-09-21T02:00:00.000Z',
    };
    report.observations[1].timestamp_utc = '2026-09-21T03:00:00.000Z';
    report.observations[2].timestamp_utc = '2026-09-21T02:00:00.000Z';
    setUptimeWindow(report, 3_600_000);

    expect(validateVSleepClassificationProvenance(report)).toBe(report);
  });

  it('rejects a classification whose trigger observation is missing', () => {
    const report = reportFixture();
    report.observations = [];

    expect(() => validateVSleepClassificationProvenance(report)).toThrow(
      /session_id: non-null session_id requires at least one observation/
    );
  });

  it('rejects a wrong-source observed row as classification provenance', () => {
    const report = reportFixture();
    report.observations[0].source = 'vrchat_log';

    expect(() => validateVSleepClassificationProvenance(report)).toThrow(
      /missing authoritative observed trigger open_vr\/hmd_disconnected at classification timestamp/
    );
  });

  it('rejects inferred evidence as classification provenance', () => {
    const report = reportFixture();
    report.observations[0].confidence = 'inferred_low';

    expect(() => validateVSleepClassificationProvenance(report)).toThrow(
      /missing authoritative observed trigger open_vr\/hmd_disconnected at classification timestamp/
    );
  });

  it('rejects an otherwise matching trigger from another session', () => {
    const report = reportFixture();
    report.observations[0].session_id = 'session-b';

    expect(() => validateVSleepClassificationProvenance(report)).toThrow(
      /observations\[0\]\.session_id: current backend report observations must match session_id/
    );
  });

  it('rejects derived classifications when the report has no unambiguous session id', () => {
    const report = reportFixture();
    report.session_id = null;

    try {
      validateVSleepClassificationProvenance(report);
      throw new Error('fixture should have failed provenance validation');
    } catch (error) {
      expect(error).toBeInstanceOf(VSleepReportIntegrityError);
      expect(error).toMatchObject({
        path: 'classifications',
        detail: 'derived classifications require an unambiguous session_id',
      });
    }
  });
});
