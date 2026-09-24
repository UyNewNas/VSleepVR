import { ApplicationRef, Injectable } from '@angular/core';
import { listen } from '@tauri-apps/api/event';
import { error } from '@tauri-apps/plugin-log';
import { BehaviorSubject, Observable } from 'rxjs';

export interface VSleepRuntimeHealthSnapshot {
  sessionId: string | null;
  observedAtMs: number;
  hmdConnected: boolean | null;
  steamvrRunning: boolean | null;
  vrchatRunning: boolean | null;
}

const HEALTH_EVENT_NAME = 'VSLEEP_HEALTH_SNAPSHOT';

@Injectable({
  providedIn: 'root',
})
export class VSleepHealthService {
  private readonly _snapshot = new BehaviorSubject<VSleepRuntimeHealthSnapshot | null>(null);
  readonly snapshot: Observable<VSleepRuntimeHealthSnapshot | null> = this._snapshot.asObservable();
  private initialized = false;

  constructor(private appRef: ApplicationRef) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    try {
      await listen<VSleepRuntimeHealthSnapshot>(HEALTH_EVENT_NAME, (event) => {
        this._snapshot.next(event.payload);
        this.appRef.tick();
      });
    } catch (cause) {
      this.initialized = false;
      error(`[VSleep] Could not subscribe to runtime health snapshots: ${cause}`);
    }
  }
}
