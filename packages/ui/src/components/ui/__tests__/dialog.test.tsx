import {afterEach, describe, expect, it} from 'vitest';
import {cleanup, render, screen} from '@testing-library/react';
import {Dialog, DialogContent, DialogTitle} from '../dialog';

afterEach(() => cleanup());

describe('DialogContent', () => {
  it('maps the sm size to max-w-md', () => {
    render(
      <Dialog open>
        <DialogContent size="sm">
          <DialogTitle>Small dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByRole('dialog').classList.contains('max-w-md')).toBe(true);
  });
});
