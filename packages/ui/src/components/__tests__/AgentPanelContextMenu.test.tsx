import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';

const {agentChat, aiStatus, copyText} = vi.hoisted(() => ({
  agentChat: vi.fn(async () => undefined),
  aiStatus: vi.fn(async () => ({ready: true, config: {provider: 'mock' as const}})),
  copyText: vi.fn(async () => true),
}));

const client = {agentChat, aiStatus};

vi.mock('@/data', () => ({useData: () => client}));
vi.mock('@/lib/pageActions', () => ({copyText}));
vi.mock('@/providers', async () => {
  const {t} = await import('@/i18n');
  return {
    useHud: () => ({setHud: vi.fn()}),
    useNavigation: () => ({
      closeSplit: vi.fn(),
      openInSplit: vi.fn(),
      primaryPageId: 'page-1',
    }),
    useTranslation: () => ({t}),
  };
});

import {AgentPanel} from '../AgentPanel';

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {configurable: true, value: vi.fn()});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AgentPanel message context menu', () => {
  it('renders Copy message and copies the selected message through the shared helper', () => {
    render(<AgentPanel />);

    fireEvent.change(screen.getByRole('textbox', {name: 'Ask anything…'}), {
      target: {value: 'Copy this message'},
    });
    fireEvent.click(screen.getByRole('button', {name: 'Send'}));

    fireEvent.contextMenu(screen.getByText('Copy this message').closest('[data-agent-item="user"]')!);

    expect(screen.queryByRole('menuitem', {name: 'Retry'})).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', {name: 'Copy message'}));
    expect(copyText).toHaveBeenCalledWith('Copy this message');
  });
});
