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

export type VSleepIncidentCategory = Extract<
  VSleepFailureClass,
  'hmd_or_link_failure' | 'steam_vr_failure' | 'vrchat_failure'
>;

export type VSleepSessionBoundaryStatus =
  | 'complete'
  | 'missing_start'
  | 'missing_end'
  | 'missing_both'
  | 'invalid_order';

export interface VSleepSessionFileInfo {
  file_name: string;
  size_bytes: number;
  modified_utc: string | null;
}

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

export interface VSleepSessionBoundarySummary {
  status: VSleepSessionBoundaryStatus;
  startTimestampUtc: string | null;
  endTimestampUtc: string | null;
}

export interface VSleepIncidentWindow {
  category: VSleepIncidentCategory;
  confidence: VSleepEventConfidence;
  startTimestampUtc: string;
  endTimestampUtc: string | null;
  durationMs: number | null;
  recoveryObservation: VSleepSessionEvent | null;
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
  async listSessions(): Promise<VSleepSessionFileInfo[]> {
    return invoke<VSleepSessionFileInfo[]>('vsleep_list_sessions');
  }

  async readSessionReport(fileName: string): Promise<VSleepSessionReport> {
    return invoke<VSleepSessionReport>('vsleep_read_session_report', { fileName });
  }

  async readLatestSessionReport(): Promise<VSleepSessionReport | null> {
    const [latest] = await this.listSessions();
    if (!latest) return null;
    return this.readSessionReport(latest.file_name);
  }

  summarizeSessionBoundaries(report: VSleepSessionReport): VSleepSessionBoundarySummary {
    if (!report.session_id) {
      return {
        status: 'missing_both',
        startTimestampUtc: null,
        endTimestampUtc: null,
      };
    }

    const boundaryEvents = report.observations
      .filter(
        (observation) =>
          observation.session_id === report.session_id &&
          observation.confidence === 'observed' &&
          (observation.kind === 'session_started' || observation.kind === 'session_ended')
      )
      .sort((a, b) => Date.parse(a.timestamp_utc) - Date.parse(b.timestamp_utc));

    const start = boundaryEvents.find((observation) => observation.kind === 'session_started') ?? null;
    const end =
      [...boundaryEvents].reverse().find((observation) => observation.kind === 'session_ended') ?? null;

    if (!start && !end) {
      return {
        status: 'missing_both',
        startTimestampUtc: null,
        endTimestampUtc: null,
      };
    }
    if (!start) {
      return {
        status: 'missing_start',
        startTimestampUtc: null,
        endTimestampUtc: end?.timestamp_utc ?? null,
      };
    }
    if (!end) {
      return {
        status: 'missing_end',
        startTimestampUtc: start.timestamp_utc,
        endTimestampUtc: null,
      };
    }

    const startMs = Date.parse(start.timestamp_utc);
    const endMs = Date.parse(end.timestamp_utc);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
      return {
        status: 'invalid_order',
        startTimestampUtc: start.timestamp_utc,
        endTimestampUtc: end.timestamp_utc,
      };
    }

    return {
      status: 'complete',
      startTimestampUtc: start.timestamp_utc,
      endTimestampUtc: end.timestamp_utc,
    };
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

  toIncidentWindows(report: VSleepSessionReport): VSleepIncidentWindow[] {
    type IncidentEvent =
      | {
          entryType: 'classification';
          timestampUtc: string;
          classification: VSleepFailureClassification;
        }
      | {
          entryType: 'recovery';
          timestampUtc: string;
          observation: VSleepSessionEvent;
        };

    const events: IncidentEvent[] = [
      ...report.classifications
        .filter((classification) => this.isIncidentCategory(classification.category))
        .map(
          (classification): IncidentEvent => ({
            entryType: 'classification',
            timestampUtc: classification.timestamp_utc,
            classification,
          })
        ),
      ...report.observations
        .filter(
          (observation) =>
            observation.confidence === 'observed' &&
            this.incidentCategoryForRecovery(observation.kind) !== null
        )
        .map(
          (observation): IncidentEvent => ({
            entryType: 'recovery',
            timestampUtc: observation.timestamp_utc,
            observation,
          })
        ),
    ].sort((a, b) => {
      const timestampDelta = Date.parse(a.timestampUtc) - Date.parse(b.timestampUtc);
      if (timestampDelta !== 0) return timestampDelta;
      if (a.entryType === b.entryType) return 0;
      return a.entryType === 'classification' ? -1 : 1;
    });

    const active = new Map<VSleepIncidentCategory, VSleepIncidentWindow>();
    const windows: VSleepIncidentWindow[] = [];

    for (const event of events) {
      if (event.entryType === 'classification') {
        if (!this.isIncidentCategory(event.classification.category)) continue;
        if (active.has(event.classification.category)) continue;

        const incident: VSleepIncidentWindow = {
          category: event.classification.category,
          confidence: event.classification.confidence,
          startTimestampUtc: event.classification.timestamp_utc,
          endTimestampUtc: null,
          durationMs: null,
          recoveryObservation: null,
        };
        active.set(event.classification.category, incident);
        windows.push(incident);
        continue;
      }

      const category = this.incidentCategoryForRecovery(event.observation.kind);
      if (!category) continue;
      const incident = active.get(category);
      if (!incident) continue;

      const startMs = Date.parse(incident.startTimestampUtc);
      const endMs = Date.parse(event.observation.timestamp_utc);
      incident.endTimestampUtc = event.observation.timestamp_utc;
      incident.durationMs =
        Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
          ? endMs - startMs
          : null;
      incident.recoveryObservation = event.observation;
      active.delete(category);
    }

    return windows;
  }

  private isIncidentCategory(category: VSleepFailureClass): category is VSleepIncidentCategory {
    return (
      category === 'hmd_or_link_failure' ||
      category === 'steam_vr_failure' ||
      category === 'vrchat_failure'
    );
  }

  private incidentCategoryForRecovery(kind: VSleepEventKind): VSleepIncidentCategory | null {
    switch (kind) {
      case 'hmd_connected':
        return 'hmd_or_link_failure';
      case 'steam_vr_started':
        return 'steam_vr_failure';
      case 'vrchat_started':
        return 'vrchat_failure';
      default:
        return null;
    }
  }
}
