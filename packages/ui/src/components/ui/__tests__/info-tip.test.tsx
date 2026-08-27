import {render, screen} from '@testing-library/react';
import {describe, expect, it} from 'vitest';

import {InfoTip} from '@/components/ui/info-tip';
import {TooltipProvider} from '@/components/ui/tooltip';

describe('InfoTip', () => {
  it('exposes its text to assistive technology', () => {
    render(<TooltipProvider><InfoTip text="Helpful context" /></TooltipProvider>);
    expect(screen.getByRole('button', {name: 'Helpful context'})).toBeTruthy();
  });
});
