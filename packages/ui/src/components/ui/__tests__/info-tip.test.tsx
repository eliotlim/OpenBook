import {fireEvent, render, screen} from '@testing-library/react';
import {describe, expect, it} from 'vitest';

import {InfoTip} from '@/components/ui/info-tip';
import {TooltipProvider} from '@/components/ui/tooltip';
import {I18nProvider} from '@/providers';

describe('InfoTip', () => {
  it('exposes its text to assistive technology', async () => {
    render(<I18nProvider><TooltipProvider><InfoTip text="Helpful context" /></TooltipProvider></I18nProvider>);
    const trigger = screen.getByRole('button', {name: 'More info'});
    fireEvent.focus(trigger);
    const tooltip = await screen.findByRole('tooltip');
    expect(trigger.getAttribute('aria-describedby')).toBe(tooltip.id);
    expect(tooltip.textContent).toBe('Helpful context');
  });
});
