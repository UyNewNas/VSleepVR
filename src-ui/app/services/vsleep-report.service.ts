import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

export type VSleepEventSource =
  | 'vsleep'
  | 'open_vr'
  | 'steam_vr'
  | 'vrchat_process'
  | 'vrchat_log'
  | 'windows_power'
  | 'sleep_mode';

export type VSleepEventConfidence =
  | 'observed'
  | 'inferred_high'
  | 'inferred_medium'
  | 'inferred_low';

export type VSleepEventKind =
  | 'session_started'
  | 'session_ended'
  | 'hmd_connected'
  | 'hmd_disconnected'
  | 'steam_vr_started'
  | 'steam_vr_stopped'
  | 'steam_vr_standby_entered'
  | 'steam_vr_standby_exited'
  | 'vrchat_started'
  | 'vrchat_stopped'
  | 'windows_suspend'
  | 'windows_resume'
  | 'windows_power_event'
  | 'sleep_mode_enabled'
  | 'sleep_mode_disabled';

export type VSleepFailureClass =
  | 'hmd_or_link_failure'
  | 'steam_vr_failure'
  | 'vrchat_failure'
  | 'windows_power_transition'
  | 'unknown_insufficient_evidence';

export interface VSleepSessionEvent {
  schema_version: number;
  timestamp_utc: string;
  session_id: string;
  source: VSleepEventSource;
  kind: VSleepEventKind;
  confidence: VSleepEventConfidence;
  metadata?: Record<string, unknown>;
}

export interface VSleepFailureClassification {
  timestamp_utc: string;
  category: VSleepFailureClass;
  confidence: VSleepEventConfidence;
  evidence: VSleepEventKind[];
  rationale: string;
}

export interface VSleepRuntimeUptimeSummary {
  observed_up_ms: number;
  observed_down_ms: number;
  unknown_ms: number;
  transitions: number;
}

export interface VSleepSessionUptimeSummary {
  observed_window_ms: number | null;
  hmd: VSleepRuntimeUptimeSummary;
  steamvr: VSleepRuntimeUptimeSummary;
  vrchat: VSleepRuntimeUptimeSummary;
}

export interface VSleepSessionReport {
  session_id: string | null;
  observations: VSleepSessionEvent[];
  classifications: VSleepFailureClassification[];
  uptime: VSleepSessionUptimeSummary;
}

export type VSleepTimelineEntry =
  | {
      entryType: 'observation';
      timestampUtc: string;
      observation: VSleepSessionEvent;
    }
  | {
      entryType: 'classification';
      timestampUtc: string;
      classification: VSleepFailureClassification;
    };

@Injectable({
  providedIn: 'root',
})
export class VSleepReportService {
  async readSessionReport(fileName: string): Promise<VSleepSessionReport> {
    return invoke<VSleepSessionReport>('vsleep_read_session_report', { fileName });
  }

  toTimelineEntries(report: VSleepSessionReport): VSleepTimelineEntry[] {
    const entries: VSleepTimelineEntry[] = [
      ...report.observations.map(
        (observation): VSleepTimelineEntry => ({
          entryType: 'observation',
          timestampUtc: observation.timestamp_utc,
          observation,
        })
      ),
      ...report.classifications.map(
        (classification): VSleepTimelineEntry => ({
          entryType: 'classification',
          timestampUtc: classification.timestamp_utc,
          classification,
        })
      ),
    ];

    return entries.sort((a, b) => {
      const timestampDelta = Date.parse(a.timestampUtc) - Date.parse(b.timestampUtc);
      if (timestampDelta !== 0) return timestampDelta;
      if (a.entryType === b.entryType) return 0;
      return a.entryType === 'observation' ? -1 : 1;
    });
  }
}
