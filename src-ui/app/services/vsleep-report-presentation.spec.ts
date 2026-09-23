import { describe, expect, it } from 'vitest';
import {
  vsleepClassificationEvidenceLabel,
  vsleepClassificationIsInference,
  vsleepObservationEvidenceLabel,
  vsleepObservationMarker,
} from './vsleep-report-presentation';
import type { VSleepSessionEvent } from './vsleep-report.service';

function observation(
  overrides: Partial<Pick<VSleepSessionEvent, 'timestamp_utc' | 'source' | 'kind' | 'confidence'>> = {}
): Pick<VSleepSessionEvent, 'timestamp_utc' | 'source' | 'kind' | 'confidence'> {
  return {
    timestamp_utc: '2026-09-23T17:57:57.000Z',
    source: 'open_vr',
    kind: 'hmd_connected',
    confidence: 'observed',
    ...overrides,
  };
}

describe('VSleep report presentation trust labels', () => {
  it('marks only derivation-qualified observed evidence as observed', () => {
    const event = observation();
    expect(vsleepObservationEvidenceLabel(event)).toBe('observed');
    expect(vsleepObservationMarker(event)).toBe('●');
  });

  it('does not promote inferred raw evidence to observed presentation', () => {
    for (const confidence of ['inferred_high', 'inferred_medium', 'inferred_low'] as const) {
      const event = observation({ confidence });
      expect(vsleepObservationEvidenceLabel(event)).toBe(`forensic · ${confidence}`);
      expect(vsleepObservationMarker(event)).toBe('○');
    }
  });

  it('keeps observed rows forensic when their producer is not authoritative for the kind', () => {
    const event = observation({ source: 'vrchat_log' });
    expect(vsleepObservationEvidenceLabel(event)).toBe('forensic · observed');
    expect(vsleepObservationMarker(event)).toBe('○');
  });

  it('keeps observed rows forensic when source and kind do not form an authoritative pair', () => {
    const event = observation({ source: 'open_vr', kind: 'vrchat_started' });
    expect(vsleepObservationEvidenceLabel(event)).toBe('forensic · observed');
    expect(vsleepObservationMarker(event)).toBe('○');
  });

  it('keeps backend-unparseable observed timestamps forensic', () => {
    const event = observation({ timestamp_utc: '2026-09-23T17:57:57+0000' });
    expect(vsleepObservationEvidenceLabel(event)).toBe('forensic · observed');
    expect(vsleepObservationMarker(event)).toBe('○');
  });

  it('keeps future raw confidence values forensic by default', () => {
    const event = observation({
      confidence: 'producer_specific_future_value' as VSleepSessionEvent['confidence'],
    });
    expect(vsleepObservationEvidenceLabel(event)).toBe(
      'forensic · producer_specific_future_value'
    );
    expect(vsleepObservationMarker(event)).toBe('○');
  });

  it('labels backend classifications as inferred causes or observed-evidence derivations', () => {
    expect(vsleepClassificationEvidenceLabel('inferred_high')).toBe('inferred · high');
    expect(vsleepClassificationEvidenceLabel('inferred_medium')).toBe('inferred · medium');
    expect(vsleepClassificationEvidenceLabel('inferred_low')).toBe('inferred · low');
    expect(vsleepClassificationEvidenceLabel('observed')).toBe('derived · observed evidence');
  });

  it('reserves inference styling for inferred classifications', () => {
    expect(vsleepClassificationIsInference('observed')).toBe(false);
    expect(vsleepClassificationIsInference('inferred_high')).toBe(true);
    expect(vsleepClassificationIsInference('inferred_medium')).toBe(true);
    expect(vsleepClassificationIsInference('inferred_low')).toBe(true);
  });
});
