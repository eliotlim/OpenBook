import {describe, it, expect, afterEach} from 'vitest';
import {render, cleanup} from '@testing-library/react';
import {Markdown} from '../markdown';

afterEach(() => cleanup());

/**
 * The assistant renders replies as Markdown. This guards the dependency-free
 * renderer: the block + inline constructs models actually emit must map to the
 * right elements, and links must never carry an unsafe scheme.
 */
describe('Markdown renderer', () => {
  it('renders headings, bold, italic, and inline code', () => {
    const {container} = render(<Markdown content={'# Title\n\nSome **bold** and *italic* and `code`.'} />);
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('em')?.textContent).toBe('italic');
    expect(container.querySelector('code')?.textContent).toBe('code');
    // Heading is a styled paragraph, not a literal '#'.
    expect(container.textContent).toContain('Title');
    expect(container.textContent).not.toContain('#');
  });

  it('renders ordered and unordered lists', () => {
    const {container} = render(<Markdown content={'- one\n- two\n\n1. first\n2. second'} />);
    expect(container.querySelectorAll('ul > li')).toHaveLength(2);
    expect(container.querySelectorAll('ol > li')).toHaveLength(2);
  });

  it('renders fenced code blocks verbatim', () => {
    const {container} = render(<Markdown content={'```\nconst x = 1;\n```'} />);
    const pre = container.querySelector('pre code');
    expect(pre?.textContent).toBe('const x = 1;');
  });

  it('renders safe links and rejects javascript: URLs', () => {
    const {container} = render(<Markdown content={'[ok](https://example.com) and [bad](javascript:alert(1))'} />);
    const links = container.querySelectorAll('a');
    expect(links[0].getAttribute('href')).toBe('https://example.com');
    expect(links[0].getAttribute('rel')).toContain('noopener');
    expect(links[1].getAttribute('href')).toBe('#');
  });

  it('renders partial (streaming) Markdown without throwing', () => {
    // An unterminated bold/code span should fall back to literal text.
    const {container} = render(<Markdown content={'half a **sentence and `cod'} />);
    expect(container.textContent).toContain('half a **sentence and `cod');
  });
});
