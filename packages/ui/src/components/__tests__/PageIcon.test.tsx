import {describe, it, expect, afterEach} from 'vitest';
import {render, cleanup} from '@testing-library/react';
import {PageIcon} from '../PageIcon';

describe('PageIcon', () => {
  afterEach(() => cleanup());

  it('renders an emoji glyph as text', () => {
    const {container} = render(<PageIcon value="🎯" />);
    expect(container.textContent).toBe('🎯');
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders a lucide ref as an svg (no leaked text)', () => {
    const {container} = render(<PageIcon value="lucide:Heart" />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.textContent).toBe('');
  });

  it('falls back to the default glyph when empty', () => {
    const {container} = render(<PageIcon value="" />);
    expect(container.textContent).toBe('📄');
  });

  it('shows the fallback (not the raw ref) for an unknown lucide name', () => {
    const {container} = render(<PageIcon value="lucide:Nope" fallback="📄" />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).toBe('📄');
  });

  it('renders nothing when empty and fallback is null', () => {
    const {container} = render(<PageIcon value="" fallback={null} />);
    expect(container.textContent).toBe('');
    expect(container.querySelector('svg')).toBeNull();
  });
});
