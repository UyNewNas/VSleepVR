import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { validateVSleepClassificationProvenance } from './vsleep-report-provenance';
import { parseVSleepSessionReport } from './vsleep-report-schema';

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
  | 'invalid_order'
  | 'ambiguous_boundaries'
  | 'ambiguous_session';

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

export interface VSleepSessionRecordingSummary {
  status: VSleepSessionBoundaryStatus;
  start_timestamp_utc: string | null;
  end_timestamp_utc: string | null;
}

export interface VSleepSessionReport {
  session_id: string | null;
  recording?: VSleepSessionRecordingSummary;
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
    const payload = await invoke<unknown>('vsleep_read_session_report', { fileName });
    return validateVSleepClassificationProvenance(parseVSleepSessionReport(payload));
  }

  async readLatestSessionReport(): Promise<VSleepSessionReport | null> {
    const [latest] = await this.listSessions();
    if (!latest) return null;
    return this.readSessionReport(latest.file_name);
  }

  summarizeSessionBoundaries(report: VSleepSessionReport): VSleepSessionBoundarySummary {
    // New reports carry a backend-owned recording summary. Treat it as the
    // canonical interpretation of authoritative session boundaries so the UI
    // cannot drift from classifier/uptime semantics. Keep the legacy fallback
    // below for older persisted/generated reports that predate this field.
    if (report.recording) {
      return {
        status: report.recording.status,
        startTimestampUtc: report.recording.start_timestamp_utc,
        endTimestampUtc: report.recording.end_timestamp_utc,
      };
    }

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
          observation.source === 'vsleep' &&
          observation.confidence === 'observed' &&
          this.parseTimestampMs(observation.timestamp_utc) !== null &&
          (observation.kind === 'session_started' || observation.kind === 'session_ended')
      )
      .sort(
        (a, b) =>
          (this.parseTimestampMs(a.timestamp_utc) ?? 0) -
          (this.parseTimestampMs(b.timestamp_utc) ?? 0)
      );

    const starts = boundaryEvents.filter((observation) => observation.kind === 'session_started');
    const ends = boundaryEvents.filter((observation) => observation.kind === 'session_ended');

    if (starts.length > 1 || ends.length > 1) {
      return {
        status: 'ambiguous_boundaries',
        startTimestampUtc: starts.length === 1 ? starts[0].timestamp_utc : null,
        endTimestampUtc: ends.length === 1 ? ends[0].timestamp_utc : null,
      };
    }

    const start = starts[0] ?? null;
    const end = ends[0] ?? null;

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

    const startMs = this.parseTimestampMs(start.timestamp_utc);
    const endMs = this.parseTimestampMs(end.timestamp_utc);
    if (startMs === null || endMs === null || endMs < startMs) {
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
    const boundary = this.summarizeSessionBoundaries(report);
    const entries: VSleepTimelineEntry[] = [
      ...report.observations.map(
        (observation): VSleepTimelineEntry => ({
          entryType: 'observation',
          timestampUtc: observation.timestamp_utc,
          observation,
        })
      ),
      ...report.classifications
        .filter((classification) =>
          this.isTimestampWithinRecording(classification.timestamp_utc, boundary)
        )
        .map(
          (classification): VSleepTimelineEntry => ({
            entryType: 'classification',
            timestampUtc: classification.timestamp_utc,
            classification,
          })
        ),
    ];

    return entries.sort((a, b) => {
      const aTimestamp = this.parseTimestampMs(a.timestampUtc);
      const bTimestamp = this.parseTimestampMs(b.timestampUtc);
      if (aTimestamp === null || bTimestamp === null) {
        if (aTimestamp === null && bTimestamp === null) {
          if (a.entryType === b.entryType) return 0;
          return a.entryType === 'observation' ? -1 : 1;
        }
        return aTimestamp === null ? 1 : -1;
      }

      const timestampDelta = aTimestamp - bTimestamp;
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

    const boundary = this.summarizeSessionBoundaries(report);
    const events: IncidentEvent[] = [
      ...report.classifications
        .filter(
          (classification) =>
            this.isIncidentCategory(classification.category) &&
            this.isTimestampWithinRecording(classification.timestamp_utc, boundary)
        )
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
            report.session_id !== null &&
            observation.session_id === report.session_id &&
            observation.confidence === 'observed' &&
            this.isTimestampWithinRecording(observation.timestamp_utc, boundary) &&
            this.incidentCategoryForRecovery(observation) !== null
        )
        .map(
          (observation): IncidentEvent => ({
            entryType: 'recovery',
            timestampUtc: observation.timestamp_utc,
            observation,
          })
        ),
    ].sort((a, b) => {
      const aTimestamp = this.parseTimestampMs(a.timestampUtc);
      const bTimestamp = this.parseTimestampMs(b.timestampUtc);
      if (aTimestamp === null || bTimestamp === null) return 0;
      const timestampDelta = aTimestamp - bTimestamp;
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

      const category = this.incidentCategoryForRecovery(event.observation);
      if (!category) continue;
      const incident = active.get(category);
      if (!incident) continue;

      const startMs = this.parseTimestampMs(incident.startTimestampUtc);
      const endMs = this.parseTimestampMs(event.observation.timestamp_utc);
      if (startMs === null || endMs === null || endMs < startMs) continue;

      incident.endTimestampUtc = event.observation.timestamp_utc;
      incident.durationMs = endMs - startMs;
      incident.recoveryObservation = event.observation;
      active.delete(category);
    }

    return windows;
  }

  private isTimestampWithinRecording(
    timestampUtc: string,
    boundary: VSleepSessionBoundarySummary
  ): boolean {
    const timestampMs = this.parseTimestampMs(timestampUtc);
    if (timestampMs === null) return false;

    // Mixed-session reports are explicitly quarantined by the backend. Keep raw
    // observations visible, but never surface derived classification/incident
    // data if a malformed or stale frontend payload contains any.
    if (boundary.status === 'ambiguous_session') return false;

    // A partial recording still contains trustworthy one-sided bounds. Use any
    // unique authoritative boundary that is available instead of dropping all
    // bounds merely because the opposite edge is missing or ambiguous. This is
    // especially important for host/app-exit truncation: a missing session end
    // must not let pre-session derived classifications leak into the report.
    // Reversed boundaries are internally inconsistent, so keep evidence visible
    // rather than inventing a usable interval from contradictory timestamps.
    if (boundary.status === 'invalid_order') return true;

    const startMs = boundary.startTimestampUtc
      ? this.parseTimestampMs(boundary.startTimestampUtc)
      : null;
    const endMs = boundary.endTimestampUtc ? this.parseTimestampMs(boundary.endTimestampUtc) : null;

    if (startMs !== null && timestampMs < startMs) return false;
    if (endMs !== null && timestampMs > endMs) return false;
    return true;
  }

  private parseTimestampMs(timestampUtc: string): number | null {
    const timestampMs = Date.parse(timestampUtc);
    return Number.isFinite(timestampMs) ? timestampMs : null;
  }

  private isIncidentCategory(category: VSleepFailureClass): category is VSleepIncidentCategory {
    return (
      category === 'hmd_or_link_failure' ||
      category === 'steam_vr_failure' ||
      category === 'vrchat_failure'
    );
  }

  private incidentCategoryForRecovery(
    observation: Pick<VSleepSessionEvent, 'source' | 'kind'>
  ): VSleepIncidentCategory | null {
    switch (observation.kind) {
      case 'hmd_connected':
        return observation.source === 'open_vr' ? 'hmd_or_link_failure' : null;
      case 'steam_vr_started':
        return observation.source === 'steam_vr' ? 'steam_vr_failure' : null;
      case 'vrchat_started':
        return observation.source === 'vrchat_process' ? 'vrchat_failure' : null;
      default:
        return null;
    }
  }
}
