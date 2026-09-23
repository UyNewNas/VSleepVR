import { describe, expect, it } from 'vitest';
import { validateVSleepClassificationProvenance } from './vsleep-report-provenance';
import { parseVSleepSessionReport } from './vsleep-report-schema';
import {
  parseVSleepRfc3339TimestampMs,
  toVSleepDisplayDate,
} from './vsleep-report-timestamp';
import type { VSleepSessionReport } from './vsleep-report.service';

function zeroRuntime(unknownMs: number) {
  return {
    observed_up_ms: 0,
    observed_down_ms: 0,
    unknown_ms: unknownMs,
    transitions: 0,
  };
}

describe('VSleep RFC3339 timestamp boundary', () => {
  it('accepts backend-compatible RFC3339 forms and preserves millisecond ordering', () => {
    const utc = parseVSleepRfc3339TimestampMs('2026-09-23T14:00:00.123Z');
    const space = parseVSleepRfc3339TimestampMs('2026-09-23 14:00:00.123Z');
    const lowercase = parseVSleepRfc3339TimestampMs('2026-09-23t14:00:00.123z');
    const offset = parseVSleepRfc3339TimestampMs('2026-09-23T15:30:00.123+01:30');
    const submillisecond = parseVSleepRfc3339TimestampMs('2026-09-23T14:00:00.123456789Z');

    expect(utc).not.toBeNull();
    expect(space).toBe(utc);
    expect(lowercase).toBe(utc);
    expect(offset).toBe(utc);
    expect(submillisecond).toBe(utc);
  });

  it('normalizes Chrono-compatible leap seconds to the backend millisecond instant', () => {
    expect(parseVSleepRfc3339TimestampMs('2015-06-30T23:59:60.500Z')).toBe(
      parseVSleepRfc3339TimestampMs('2015-07-01T00:00:00.500Z')
    );
  });

  it('rejects JavaScript-only timestamp conveniences the backend does not derive from', () => {
    expect(parseVSleepRfc3339TimestampMs('2026-09-23T14:00:00')).toBeNull();
    expect(parseVSleepRfc3339TimestampMs('2026-02-31T14:00:00Z')).toBeNull();
    expect(parseVSleepRfc3339TimestampMs('2026-09-23T24:00:00Z')).toBeNull();
    expect(parseVSleepRfc3339TimestampMs('2026-09-23T14:00:00+0000')).toBeNull();
  });

  it('does not normalize forensic-only timestamp strings into trusted display dates', () => {
    const canonical = '2026-09-23T14:00:00.123Z';
    const displayDate = toVSleepDisplayDate(canonical);
    expect(displayDate?.getTime()).toBe(parseVSleepRfc3339TimestampMs(canonical));

    const colonlessOffset = '2026-09-23T14:00:00+0000';
    expect(Date.parse(colonlessOffset)).not.toBeNaN();
    expect(toVSleepDisplayDate(colonlessOffset)).toBeNull();
    expect(toVSleepDisplayDate('2026-09-23T14:00:00')).toBeNull();
  });

  it('fails closed when backend-owned classification time is only Date.parse-compatible', () => {
    const payload = {
      session_id: 'session-a',
      recording: {
        status: 'missing_both',
        start_timestamp_utc: null,
        end_timestamp_utc: null,
      },
      observations: [],
      classifications: [
        {
          timestamp_utc: '2026-09-23T14:00:00+0000',
          category: 'unknown_insufficient_evidence',
          confidence: 'inferred_low',
          evidence: ['hmd_disconnected'],
          rationale: 'backend-owned reliability classification',
        },
      ],
      uptime: {
        observed_window_ms: 0,
        hmd: zeroRuntime(0),
        steamvr: zeroRuntime(0),
        vrchat: zeroRuntime(0),
      },
    };

    expect(() => parseVSleepSessionReport(payload)).toThrow(
      /classifications\[0\]\.timestamp_utc: expected parseable timestamp in RFC3339 format/
    );
  });

  it('keeps Date.parse-only raw rows forensic instead of letting them establish a boundary', () => {
    const report: VSleepSessionReport = {
      session_id: 'session-a',
      recording: {
        status: 'missing_start',
        start_timestamp_utc: null,
        end_timestamp_utc: '2026-09-23T14:02:00.000Z',
      },
      observations: [
        {
          schema_version: 1,
          timestamp_utc: '2026-09-23T14:00:00+0000',
          session_id: 'session-a',
          source: 'vsleep',
          kind: 'session_started',
          confidence: 'observed',
        },
        {
          schema_version: 1,
          timestamp_utc: '2026-09-23T14:01:00.000Z',
          session_id: 'session-a',
          source: 'open_vr',
          kind: 'hmd_connected',
          confidence: 'observed',
        },
        {
          schema_version: 1,
          timestamp_utc: '2026-09-23T14:02:00.000Z',
          session_id: 'session-a',
          source: 'vsleep',
          kind: 'session_ended',
          confidence: 'observed',
        },
      ],
      classifications: [],
      uptime: {
        observed_window_ms: 60_000,
        hmd: zeroRuntime(60_000),
        steamvr: zeroRuntime(60_000),
        vrchat: zeroRuntime(60_000),
      },
    };

    expect(validateVSleepClassificationProvenance(report)).toBe(report);
  });
});
