import {test, expect} from './fixtures';

/**
 * Real-browser isolation proof for the SandboxedHtml renderer (the first
 * sandboxed-iframe surface in the codebase). jsdom/happy-dom cannot execute
 * iframe scripts, so the cross-origin guarantees MUST be asserted here, in
 * Chromium, against the /sandbox-lab internal harness.
 *
 * What we prove:
 *  - scripts inside the sandboxed HTML RUN and mutate their own DOM;
 *  - they CANNOT read the parent's cookies or DOM, and window.top is contained;
 *  - a </script>-bearing breakout payload does not escape into the host page.
 */

const LAB = '/sandbox-lab';

test.describe('SandboxedHtml isolation', () => {
  test('interactive artifact runs its own inline JS', async ({page}) => {
    await page.goto(LAB);
    const demo = page.locator('[data-testid="demo-counter"]');
    await demo.scrollIntoViewIfNeeded();

    const frame = page.frameLocator('[data-testid="demo-counter"] iframe');
    const btn = frame.locator('#btn');
    await expect(btn).toHaveText('Count: 0');
    await btn.click();
    await btn.click();
    await expect(btn).toHaveText('Count: 2');
  });

  test('sandboxed script cannot reach parent cookie, parent DOM, or window.top', async ({page, context}) => {
    // A real parent cookie + a parent-only secret element: if isolation leaked,
    // the probe would print their values instead of BLOCKED.
    await context.addCookies([
      {name: 'session', value: 'super-secret', url: 'http://localhost:3000'},
    ]);
    await page.goto(LAB);
    // Sanity: the cookie really exists on the parent document.
    expect(await page.evaluate(() => document.cookie)).toContain('session=super-secret');

    const demo = page.locator('[data-testid="demo-probe"]');
    await demo.scrollIntoViewIfNeeded();
    const out = page.frameLocator('[data-testid="demo-probe"] iframe').locator('#out');

    // The script ran (isolation is meaningless if scripts were simply disabled).
    await expect(out).toContainText('scripts-run:yes');
    await expect(out).toContainText('has-parent:true');

    // Every cross-origin escape was blocked by the opaque origin.
    await expect(out).toContainText('parent-cookie:BLOCKED');
    await expect(out).toContainText('parent-dom:BLOCKED');
    await expect(out).toContainText('top-href:BLOCKED');
    await expect(out).toContainText('own-cookie:BLOCKED');

    // Belt and braces: the secret value never appears anywhere in the frame.
    await expect(out).not.toContainText('super-secret');
    await expect(out).not.toContainText('top-secret-parent-value');
  });

  test('a </script> breakout payload does not escape into the host page', async ({page}) => {
    await page.goto(LAB);
    // The harness sets its title on mount; wait for that baseline before we can
    // meaningfully assert the frame did not overwrite it.
    await expect.poll(() => page.title()).toBe('Sandbox Lab');

    const demo = page.locator('[data-testid="demo-breakout"]');
    await demo.scrollIntoViewIfNeeded();

    // The payload renders INSIDE the frame (contained), not the parent.
    const frame = page.frameLocator('[data-testid="demo-breakout"] iframe');
    await expect(frame.locator('#before')).toHaveText('before');
    await expect(frame.locator('#after')).toHaveText('after');

    // The frame's attempt to overwrite the PARENT title was blocked — the title
    // never became 'PWNED' even after the frame's script ran.
    expect(await page.title()).toBe('Sandbox Lab');

    // No breakout injected nodes into the host: the demo wrapper holds exactly
    // one iframe and nothing else leaked out beside it.
    await expect(demo.locator('iframe')).toHaveCount(1);
    // The parent body never received the frame's own onerror mutation
    // (that data-attr belongs to the frame's document, not ours).
    expect(await page.evaluate(() => document.body.getAttribute('data-frame-onerror'))).toBeNull();
  });

  test('empty content shows the empty state, not a frame', async ({page}) => {
    await page.goto(LAB);
    const empty = page.locator('[data-testid="demo-empty"]');
    await empty.scrollIntoViewIfNeeded();
    await expect(empty.getByTestId('sandboxed-html-empty')).toBeVisible();
    await expect(empty.locator('iframe')).toHaveCount(0);
  });
});
