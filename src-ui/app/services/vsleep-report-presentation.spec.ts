import { describe, expect, it } from 'vitest';
import {
  vsleepObservationEvidenceLabel,
  vsleepObservationMarker,
} from './vsleep-report-presentation';

describe('VSleep report presentation trust labels', () => {
  it('keeps directly observed evidence visually explicit', () => {
    expect(vsleepObservationEvidenceLabel('observed')).toBe('observed');
    expect(vsleepObservationMarker('observed')).toBe('●');
  });

  it('does not promote inferred raw evidence to observed presentation', () => {
    for (const confidence of ['inferred_high', 'inferred_medium', 'inferred_low']) {
      expect(vsleepObservationEvidenceLabel(confidence)).toBe(`forensic · ${confidence}`);
      expect(vsleepObservationMarker(confidence)).toBe('○');
    }
  });

  it('keeps future raw confidence values forensic by default', () => {
    expect(vsleepObservationEvidenceLabel('producer_specific_future_value')).toBe(
      'forensic · producer_specific_future_value'
    );
    expect(vsleepObservationMarker('producer_specific_future_value')).toBe('○');
  });
});
