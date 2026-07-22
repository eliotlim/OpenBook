import React from 'react';
import {describe, it, expect, vi, afterEach} from 'vitest';
import {render, screen, cleanup, fireEvent} from '@testing-library/react';
import {ErrorBoundary, ErrorFallback} from '../ErrorBoundary';

const Boom: React.FC<{throwNow: boolean}> = ({throwNow}) => {
  if (throwNow) throw new Error('kaboom');
  return <div>healthy content</div>;
};

describe('ErrorBoundary', () => {
  afterEach(cleanup);

  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary fallback={() => <div>fallback</div>}>
        <Boom throwNow={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('healthy content')).toBeTruthy();
  });

  it('renders the fallback and reports the error on a render throw', () => {
    const onError = vi.fn();
    // The boundary logs the caught error to console.error; silence it.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary onError={onError} fallback={({error}) => <div>caught: {error.message}</div>}>
        <Boom throwNow />
      </ErrorBoundary>,
    );
    expect(screen.getByText('caught: kaboom')).toBeTruthy();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    spy.mockRestore();
  });

  it('resets when resetKey changes (navigating to a healthy page recovers)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const {rerender} = render(
      <ErrorBoundary resetKey="p1" fallback={() => <div>fallback</div>}>
        <Boom throwNow />
      </ErrorBoundary>,
    );
    expect(screen.getByText('fallback')).toBeTruthy();
    // A new page id + healthy content: the boundary clears its caught error.
    rerender(
      <ErrorBoundary resetKey="p2" fallback={() => <div>fallback</div>}>
        <Boom throwNow={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('healthy content')).toBeTruthy();
    spy.mockRestore();
  });
});

describe('ErrorFallback', () => {
  afterEach(cleanup);

  it('wires the Home and Reload actions and exposes an alert role', () => {
    const onHome = vi.fn();
    const onReload = vi.fn();
    render(<ErrorFallback onHome={onHome} onReload={onReload} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Go to Home'}));
    fireEvent.click(screen.getByRole('button', {name: 'Reload'}));
    expect(onHome).toHaveBeenCalledOnce();
    expect(onReload).toHaveBeenCalledOnce();
  });

  it('omits an action button when its handler is absent', () => {
    render(<ErrorFallback onHome={() => undefined} />);
    expect(screen.queryByRole('button', {name: 'Reload'})).toBeNull();
    expect(screen.getByRole('button', {name: 'Go to Home'})).toBeTruthy();
  });
});
