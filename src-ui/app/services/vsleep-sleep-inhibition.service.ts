import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { error } from '@tauri-apps/plugin-log';
import { BehaviorSubject, interval, Observable } from 'rxjs';

export interface VSleepSleepInhibitionStatus {
  sessionActive: boolean;
  inhibitionActive: boolean;
}

@Injectable({
  providedIn: 'root',
})
export class VSleepSleepInhibitionService {
  private readonly _status = new BehaviorSubject<VSleepSleepInhibitionStatus>({
    sessionActive: false,
    inhibitionActive: false,
  });
  readonly status: Observable<VSleepSleepInhibitionStatus> = this._status.asObservable();

  private initialized = false;
  private operation: Promise<void> = Promise.resolve();

  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    void this.refresh().catch((cause) => this.logFailure('initial status read', cause));
    interval(2000).subscribe(() => {
      void this.refresh().catch((cause) => this.logFailure('status refresh', cause));
    });
  }

  refresh(): Promise<void> {
    return this.enqueue(async () => {
      const [sessionId, inhibitionActive] = await Promise.all([
        invoke<string | null>('vsleep_active_session_id'),
        invoke<boolean>('vsleep_sleep_inhibition_active'),
      ]);
      this._status.next({
        sessionActive: sessionId !== null,
        inhibitionActive,
      });
    });
  }

  setEnabled(enabled: boolean): Promise<void> {
    return this.enqueue(async () => {
      const inhibitionActive = await invoke<boolean>('vsleep_set_sleep_inhibition', { enabled });
      const sessionId = await invoke<string | null>('vsleep_active_session_id');
      this._status.next({
        sessionActive: sessionId !== null,
        inhibitionActive,
      });
    });
  }

  async toggle(): Promise<void> {
    const current = this._status.value;
    if (!current.sessionActive && !current.inhibitionActive) return;

    try {
      await this.setEnabled(!current.inhibitionActive);
    } catch (cause) {
      this.logFailure('toggle', cause);
      throw cause;
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.operation.then(operation);
    this.operation = next.catch(() => undefined);
    return next;
  }

  private logFailure(operation: string, cause: unknown): void {
    void error(`[VSleep] Sleep inhibition ${operation} failed: ${String(cause)}`);
  }
}
