import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import type {StoredComment, StoredSuggestion} from '@book.dev/sdk';
import {I18nProvider} from '@/providers';

const {copyText} = vi.hoisted(() => ({copyText: vi.fn(async () => true)}));

vi.mock('@/lib/pageActions', () => ({copyText}));
vi.mock('@/blockeditor/RichTextEditor', () => ({
  RichTextEditor: () => null,
  RichTextView: ({runs}: {runs: Array<{t: string}>}) => <p>{runs.map((run) => run.t).join('')}</p>,
  runsHaveText: () => false,
}));

import {MENU_DESTRUCTIVE_CLASS} from '@/components/ui/menu-components';
import {CommentThread} from '../CommentThread';
import {SuggestionCard} from '../SuggestionCard';

const suggestion: StoredSuggestion = {
  id: 'suggestion-1',
  pageId: 'page-1',
  authorKind: 'human',
  authorName: 'Reviewer',
  kind: 'replace-text',
  target: {blockId: 'block-1'},
  before: 'old words',
  after: 'new words',
  status: 'open',
  payload: {summary: 'Replace the words'},
  createdAt: '2026-08-11T00:00:00.000Z',
  updatedAt: '2026-08-11T00:00:00.000Z',
};

const comment: StoredComment = {
  id: 'comment-1',
  pageId: 'page-1',
  suggestionId: null,
  blockId: 'block-1',
  authorName: 'Reviewer',
  body: [{t: 'quoted comment'}],
  createdAt: '2026-08-11T00:00:00.000Z',
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('review context menus', () => {
  it('renders suggestion actions and reuses the accept handler', () => {
    const onAccept = vi.fn();
    render(
      <I18nProvider>
        <SuggestionCard
          suggestion={suggestion}
          comments={[]}
          authorName="Reviewer"
          onAccept={onAccept}
          onReject={vi.fn()}
          onPostComment={vi.fn()}
          onDeleteComment={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.contextMenu(document.querySelector('[data-suggestion="suggestion-1"]')!);

    const reject = screen.getByRole('menuitem', {name: 'Reject suggestion'});
    for (const className of MENU_DESTRUCTIVE_CLASS.split(' ')) {
      expect(reject.className.split(' ')).toContain(className);
    }
    expect(screen.getByRole('menuitem', {name: 'Copy'})).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', {name: 'Accept suggestion'}));

    expect(onAccept).toHaveBeenCalledWith(suggestion);
  });

  it('copies the text of an individual comment card', () => {
    render(
      <I18nProvider>
        <CommentThread
          comments={[comment]}
          newComment={{pageId: 'page-1', blockId: 'block-1', suggestionId: null}}
          authorName="Reviewer"
          onPost={vi.fn()}
          onDelete={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.contextMenu(screen.getByText('quoted comment').closest('li')!);
    fireEvent.click(screen.getByRole('menuitem', {name: 'Copy'}));

    expect(copyText).toHaveBeenCalledWith('quoted comment');
  });
});
