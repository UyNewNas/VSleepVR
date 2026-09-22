import { Component, DestroyRef, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { fade, hshrink, noop } from '../../../../utils/animations';
import { SleepService } from '../../../../services/sleep.service';
import { OpenVRService } from '../../../../services/openvr.service';
import { OscService } from '../../../../services/osc.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SleepPreparationService } from '../../../../services/sleep-preparation.service';
import { isHolidaysEventActive } from 'src-ui/app/utils/event-utils';
import { VSleepReportService } from '../../../../services/vsleep-report.service';
import type {
  VSleepIncidentWindow,
  VSleepSessionBoundarySummary,
  VSleepSessionFileInfo,
  VSleepSessionReport,
  VSleepTimelineEntry,
} from '../../../../services/vsleep-report.service';

type IllustrationVariant = 'sleep' | 'peek' | 'awake' | 'awake-hover';

@Component({
  selector: 'app-overview-view',
  templateUrl: './overview-view.component.html',
  styleUrls: ['./overview-view.component.scss'],
  animations: [noop(), fade(), hshrink()],
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: false,
})
export class OverviewViewComponent implements OnInit {
  sleepModeActive = false;
  illustrationPath: string | null = null;
  illustrationVariant: IllustrationVariant | null = null;
  mouseover = false;
  vsleepSessions: VSleepSessionFileInfo[] = [];
  vsleepSelectedSessionIndex = 0;
  vsleepReport: VSleepSessionReport | null = null;
  vsleepBoundary: VSleepSessionBoundarySummary | null = null;
  vsleepTimeline: VSleepTimelineEntry[] = [];
  vsleepIncidents: VSleepIncidentWindow[] = [];
  vsleepReportLoading = true;
  vsleepReportFailed = false;
  private vsleepReportLoadGeneration = 0;

  constructor(
    private sleep: SleepService,
    public openvr: OpenVRService,
    public osc: OscService,
    private destroyRef: DestroyRef,
    protected sleepPreparation: SleepPreparationService,
    private vsleepReports: VSleepReportService
  ) {}

  ngOnInit(): void {
    this.sleep.mode.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((sleepModeActive) => {
      this.sleepModeActive = sleepModeActive;
      this.determineIllustrationPath();
    });
    void this.refreshVSleepReport();
  }

  async setSleepMode(enabled: boolean) {
    if (enabled) {
      await this.sleep.enableSleepMode({ type: 'MANUAL' });
    } else {
      await this.sleep.disableSleepMode({ type: 'MANUAL' });
    }
  }

  protected determineIllustrationPath(mouseover: boolean | null = null) {
    if (mouseover !== null) this.mouseover = mouseover;
    const tags = ['illustration'];

    if (isHolidaysEventActive()) tags.push('holidays');

    let variant: IllustrationVariant = 'awake';
    if (this.sleepModeActive) {
      variant = this.mouseover ? 'peek' : 'sleep';
    } else {
      variant = this.mouseover ? 'awake-hover' : 'awake';
    }
    tags.push(variant);

    this.illustrationVariant = variant;
    this.illustrationPath = `assets/img/${tags.join('_')}.png`;
  }

  protected formatVSleepDuration(milliseconds: number | null): string {
    if (milliseconds === null) return '—';

    const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
    if (totalSeconds < 60) return `${totalSeconds}s`;

    const totalMinutes = Math.round(totalSeconds / 60);
    if (totalMinutes < 60) return `${totalMinutes}m`;

    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }

  protected formatVSleepTime(timestampUtc: string): string {
    const timestamp = new Date(timestampUtc);
    if (Number.isNaN(timestamp.getTime())) return timestampUtc;
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(timestamp);
  }

  protected formatVSleepSessionDate(timestampUtc: string | null): string {
    if (!timestampUtc) return '—';
    const timestamp = new Date(timestampUtc);
    if (Number.isNaN(timestamp.getTime())) return '—';
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(timestamp);
  }

  protected vsleepEntryLabel(entry: VSleepTimelineEntry): string {
    return entry.entryType === 'observation'
      ? entry.observation.kind
      : entry.classification.category;
  }

  protected vsleepIncidentLabel(incident: VSleepIncidentWindow): string {
    switch (incident.category) {
      case 'hmd_or_link_failure':
        return 'HMD / Link';
      case 'steam_vr_failure':
        return 'SteamVR';
      case 'vrchat_failure':
        return 'VRChat';
    }
  }

  protected vsleepBoundaryLabel(boundary: VSleepSessionBoundarySummary): string {
    switch (boundary.status) {
      case 'complete':
        return 'Complete recording';
      case 'missing_start':
        return 'Partial · start boundary missing';
      case 'missing_end':
        return 'Partial · end boundary missing';
      case 'missing_both':
        return 'Partial · session boundaries missing';
      case 'invalid_order':
        return 'Invalid · boundary order';
      case 'ambiguous_boundaries':
        return 'Ambiguous · duplicate session boundaries';
    }
  }

  protected async refreshVSleepReport(): Promise<void> {
    const generation = ++this.vsleepReportLoadGeneration;
    const followLatest = this.vsleepSelectedSessionIndex === 0;
    const selectedFileName = followLatest
      ? null
      : (this.vsleepSessions[this.vsleepSelectedSessionIndex]?.file_name ?? null);

    this.vsleepReportLoading = true;
    this.vsleepReportFailed = false;

    try {
      const sessions = await this.vsleepReports.listSessions();
      if (generation !== this.vsleepReportLoadGeneration) return;

      this.vsleepSessions = sessions;
      if (sessions.length === 0) {
        this.vsleepSelectedSessionIndex = 0;
        this.applyVSleepReport(null);
        return;
      }

      const preservedIndex = selectedFileName
        ? sessions.findIndex((session) => session.file_name === selectedFileName)
        : -1;
      this.vsleepSelectedSessionIndex = preservedIndex >= 0 ? preservedIndex : 0;

      const report = await this.vsleepReports.readSessionReport(
        sessions[this.vsleepSelectedSessionIndex].file_name
      );
      if (generation !== this.vsleepReportLoadGeneration) return;
      this.applyVSleepReport(report);
    } catch {
      if (generation !== this.vsleepReportLoadGeneration) return;
      this.applyVSleepReport(null);
      this.vsleepReportFailed = true;
    } finally {
      if (generation === this.vsleepReportLoadGeneration) {
        this.vsleepReportLoading = false;
      }
    }
  }

  protected async selectVSleepSession(index: number): Promise<void> {
    if (index < 0 || index >= this.vsleepSessions.length) return;
    if (index === this.vsleepSelectedSessionIndex && this.vsleepReport !== null) return;

    const generation = ++this.vsleepReportLoadGeneration;
    this.vsleepSelectedSessionIndex = index;
    this.vsleepReportLoading = true;
    this.vsleepReportFailed = false;

    try {
      const report = await this.vsleepReports.readSessionReport(
        this.vsleepSessions[index].file_name
      );
      if (generation !== this.vsleepReportLoadGeneration) return;
      this.applyVSleepReport(report);
    } catch {
      if (generation !== this.vsleepReportLoadGeneration) return;
      this.applyVSleepReport(null);
      this.vsleepReportFailed = true;
    } finally {
      if (generation === this.vsleepReportLoadGeneration) {
        this.vsleepReportLoading = false;
      }
    }
  }

  private applyVSleepReport(report: VSleepSessionReport | null): void {
    this.vsleepReport = report;
    this.vsleepBoundary = report ? this.vsleepReports.summarizeSessionBoundaries(report) : null;
    this.vsleepTimeline = report ? this.vsleepReports.toTimelineEntries(report) : [];
    this.vsleepIncidents = report ? this.vsleepReports.toIncidentWindows(report) : [];
  }
}
