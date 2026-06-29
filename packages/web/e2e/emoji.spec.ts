import {test, expect} from './fixtures';

// The inline `:shortcode` emoji flow was an EditorJS-only affordance and went
// away with the classic editor; the profile avatar's grid picker lives on.
test('the profile avatar opens the grid picker and applies a choice', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'Settings'}).first().click();
  await page.getByRole('button', {name: 'Profile'}).click();

  const avatar = page.locator('#ob-profile-avatar');
  await expect(avatar).toHaveText('🙂'); // the fallback before a pick
  await avatar.click();

  // The in-house grid picker (replaced emoji-picker-react): a search box + a
  // glyph grid inside a Radix popover.
  const search = page.getByPlaceholder('Search emoji…');
  await expect(search).toBeVisible();
  await search.fill('heart');
  const picker = page.locator('[data-radix-popper-content-wrapper]');
  await picker.locator('button[title]').first().click(); // first matching glyph

  await expect(search).toBeHidden(); // picking closes the popover
  await expect(avatar).not.toHaveText('🙂'); // the avatar updated to the pick
});
