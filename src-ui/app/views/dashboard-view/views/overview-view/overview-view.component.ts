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
  vsleepReport: VSleepSessionReport | null = null;
  vsleepTimeline: VSleepTimelineEntry[] = [];
  vsleepReportLoading = true;
  vsleepReportFailed = false;

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
    void this.loadLatestVSleepReport();
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

  protected vsleepEntryLabel(entry: VSleepTimelineEntry): string {
    return entry.entryType === 'observation'
      ? entry.observation.kind
      : entry.classification.category;
  }

  private async loadLatestVSleepReport(): Promise<void> {
    this.vsleepReportLoading = true;
    this.vsleepReportFailed = false;
    try {
      this.vsleepReport = await this.vsleepReports.readLatestSessionReport();
      this.vsleepTimeline = this.vsleepReport
        ? this.vsleepReports.toTimelineEntries(this.vsleepReport).slice(-8)
        : [];
    } catch {
      this.vsleepReport = null;
      this.vsleepTimeline = [];
      this.vsleepReportFailed = true;
    } finally {
      this.vsleepReportLoading = false;
    }
  }
}
