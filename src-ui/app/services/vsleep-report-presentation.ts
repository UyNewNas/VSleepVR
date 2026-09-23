export function vsleepObservationEvidenceLabel(confidence: string): string {
  return confidence === 'observed' ? 'observed' : `forensic · ${confidence}`;
}

export function vsleepObservationMarker(confidence: string): '●' | '○' {
  return confidence === 'observed' ? '●' : '○';
}
