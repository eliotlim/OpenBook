// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {I18nProvider} from '@book.dev/ui';
import {SidecarDegradedBanner, useSidecarStatus} from './SidecarStatus';
import type {SidecarState} from '@book.dev/ui';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listener: null as null | ((event: {payload: SidecarState}) => void),
  unlisten: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({invoke: mocks.invoke}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, listener: (event: {payload: SidecarState}) => void) => {
    mocks.listener = listener;
    return mocks.unlisten;
  }),
}));

const state = (over: Partial<SidecarState> = {}): SidecarState => ({
  state: 'running', attempts: 0, lastExitCode: null, lastStderrTail: [], socketReady: true, ...over,
});

function Harness() {
  const sidecar = useSidecarStatus();
  return <I18nProvider><SidecarDegradedBanner sidecar={sidecar} /></I18nProvider>;
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.listener = null;
  mocks.unlisten.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SidecarDegradedBanner', () => {
  it.each([
    [state({state: 'dead', lastExitCode: 9, lastStderrTail: ['fatal socket error']}), 'The local service stopped'],
    [state({state: 'respawning', attempts: 3, socketReady: false}), 'The local service is restarting (attempt 3)'],
  ])('renders degraded lifecycle state %#', (initial, copy) => {
    render(<I18nProvider><SidecarDegradedBanner sidecar={{state: initial, degraded: true, restart: vi.fn()}} /></I18nProvider>);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText((text) => text.startsWith(copy))).toBeTruthy();
  });

  it('fetches initial state and Restart dispatches the host command', async () => {
    const dead = state({state: 'dead', socketReady: false, lastExitCode: 61, lastStderrTail: ['Connection refused']});
    mocks.invoke.mockResolvedValueOnce(dead).mockResolvedValueOnce(state());
    render(<Harness />);
    expect(await screen.findByText('Connection refused')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Restart'}));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('restart_sidecar'));
  });

  it('shows running/not-ready only after grace and clears on a healthy event', async () => {
    vi.useFakeTimers();
    mocks.invoke.mockResolvedValue(state({socketReady: false}));
    render(<Harness />);
    await act(async () => Promise.resolve());
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByText('The local service started but is not responding')).toBeTruthy();
    act(() => mocks.listener?.({payload: state()}));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the banner mounted from respawning into a not-ready retry', async () => {
    mocks.invoke.mockResolvedValue(state({state: 'respawning', attempts: 1, socketReady: false}));
    render(<Harness />);
    const alert = await screen.findByRole('alert');
    act(() => mocks.listener?.({payload: state({attempts: 1, socketReady: false})}));
    expect(screen.getByRole('alert')).toBe(alert);
    expect(screen.getByText('The local service started but is not responding')).toBeTruthy();
  });
});
