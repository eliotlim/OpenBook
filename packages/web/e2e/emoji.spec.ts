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

  const picker = page.locator('.EmojiPickerReact');
  await expect(picker).toBeVisible();
  await picker.locator('input').first().fill('heart');
  await picker.locator('[data-unified]').first().click();

  await expect(picker).toBeHidden(); // picking closes the popover
  await expect(avatar).not.toHaveText('🙂'); // the avatar updated
});
