import {beforeEach, describe, expect, it, vi} from 'vitest';

beforeEach(() => vi.resetModules());

describe('shared error log', () => {
  it('keeps the newest 50 entries and formats a newest-first text dump', async () => {
    const log = await import('../errorLog');
    for (let i = 0; i < 55; i += 1) {
      log.push({ts: Date.UTC(2026, 7, 11, 0, 0, i), subsystem: 'forwarding', code: String(500 + i), message: `failure ${i}`});
    }

    const entries = log.list();
    expect(entries).toHaveLength(50);
    expect(entries[0]).toMatchObject({code: '554', message: 'failure 54'});
    expect(entries[entries.length - 1]).toMatchObject({code: '505', message: 'failure 5'});
    expect(log.copyText().split('\n')[0]).toContain('forwarding/554: failure 54');
  });

  it('notifies subscribers and protects the buffer from snapshot mutation', async () => {
    const log = await import('../errorLog');
    const listener = vi.fn();
    const unsubscribe = log.subscribe(listener);
    log.push({subsystem: 'forwarding', message: 'first', detail: 'network down'});
    expect(listener).toHaveBeenCalledTimes(1);

    const snapshot = log.list();
    snapshot[0].message = 'mutated';
    expect(log.list()[0].message).toBe('first');

    unsubscribe();
    log.push({subsystem: 'forwarding', message: 'second'});
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
