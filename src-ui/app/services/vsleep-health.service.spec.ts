import type { ApplicationRef } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import {
  VSleepHealthService,
  type VSleepRuntimeHealthSnapshot,
} from './vsleep-health.service';

const mocks = vi.hoisted(() => ({
  listener: null as ((event: { payload: unknown }) => void) | null,
  listen: vi.fn(
    async (_eventName: string, listener: (event: { payload: unknown }) => void) => {
      mocks.listener = listener;
      return () => {};
    }
  ),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: mocks.listen,
}));

vi.mock('@tauri-apps/plugin-log', () => ({
  error: vi.fn(async () => {}),
}));

function createService() {
  const tick = vi.fn();
  const service = new VSleepHealthService({ tick } as unknown as ApplicationRef);
  return { service, tick };
}

describe('VSleepHealthService', () => {
  it('registers the health listener only once', async () => {
    mocks.listener = null;
    mocks.listen.mockClear();
    const { service } = createService();

    await service.init();
    await service.init();

    expect(mocks.listen).toHaveBeenCalledTimes(1);
    expect(mocks.listen).toHaveBeenCalledWith('VSLEEP_HEALTH_SNAPSHOT', expect.any(Function));
  });

  it('publishes observed snapshots without interpreting nullable facts', async () => {
    mocks.listener = null;
    mocks.listen.mockClear();
    const { service, tick } = createService();
    let latest: VSleepRuntimeHealthSnapshot | null = null;
    const subscription = service.snapshot.subscribe((snapshot) => (latest = snapshot));
    const snapshot: VSleepRuntimeHealthSnapshot = {
      sessionId: 'session-a',
      observedAtMs: 123,
      hmdConnected: null,
      steamvrRunning: true,
      vrchatRunning: false,
    };

    await service.init();
    mocks.listener?.({ payload: snapshot });

    expect(latest).toEqual(snapshot);
    expect(tick).toHaveBeenCalledTimes(1);
    subscription.unsubscribe();
  });
});
