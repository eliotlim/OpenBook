import {useRef} from 'react';
import {Input, inputVariants} from '@/components/ui/input';
import {Button} from '@/components/ui/button';
import {IconPicker} from '@/components/IconPicker';
import {ProfileAvatar} from '@/components/ProfileAvatar';
import {usePreferences, useTranslation} from '@/providers';
import {cn} from '@/lib/utils';
import {SettingsScreen, SettingsSection, SettingsField} from '@/components/settings/primitives';

/** Downscale an upload to a small square data URL (fits in localStorage). */
async function fileToAvatarDataUrl(file: File, size = 96): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  // Cover-crop the shorter side so faces stay centered, not squashed.
  const side = Math.min(bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close();
  return canvas.toDataURL('image/webp', 0.85);
}

/** The user's local identity: name, display name, avatar, and a short bio. */
export default function ProfileSettings() {
  const {t} = useTranslation();
  const {preferences, update} = usePreferences();
  const {name, displayName, avatar, avatarImage, bio} = preferences.profile;
  const fileRef = useRef<HTMLInputElement>(null);

  const shownName = displayName.trim() || name.trim() || t('profile.anonymous');

  return (
    <SettingsScreen title={t('profile.title')} description={t('profile.description')}>
      <SettingsSection title={t('profile.identity')}>
        {/* The avatar: initials by default (derived from the name), or an
            emoji, or an uploaded image — pick one, reset any time. */}
        <SettingsField label={t('profile.avatar')}>
          <div className="flex items-center gap-3">
            <ProfileAvatar profile={preferences.profile} className="h-14 w-14 text-lg [&[data-avatar-kind=emoji]]:text-3xl" />
            <div className="flex flex-wrap items-center gap-1.5">
              <IconPicker
                id="ob-profile-avatar"
                value={avatar}
                onPick={(emoji) => update({profile: {avatar: emoji, avatarImage: ''}})}
                ariaLabel={t('profile.avatarEmoji')}
                fallback="🙂"
                className="inline-flex h-8 items-center justify-center rounded-md border border-input bg-transparent px-3 text-base transition-colors hover:bg-accent"
              />
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                data-avatar-file
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    void fileToAvatarDataUrl(file)
                      .then((url) => update({profile: {avatar: '', avatarImage: url}}))
                      .catch(() => undefined);
                  }
                  e.target.value = '';
                }}
              />
              <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                {t('profile.avatarUpload')}
              </Button>
              {(avatar || avatarImage) && (
                <Button variant="ghost" size="sm" onClick={() => update({profile: {avatar: '', avatarImage: ''}})}>
                  {t('profile.avatarReset')}
                </Button>
              )}
            </div>
          </div>
        </SettingsField>

        <SettingsField label={t('profile.name')} hint={t('profile.nameHint')} htmlFor="ob-profile-name">
          <Input
            id="ob-profile-name"
            value={name}
            placeholder={t('profile.namePlaceholder')}
            className="max-w-xs"
            onChange={(e) => update({profile: {name: e.target.value}})}
          />
        </SettingsField>

        <SettingsField label={t('profile.displayName')} hint={t('profile.displayNameHint')} htmlFor="ob-profile-display">
          <Input
            id="ob-profile-display"
            value={displayName}
            placeholder={t('profile.displayNamePlaceholder')}
            className="max-w-xs"
            onChange={(e) => update({profile: {displayName: e.target.value}})}
          />
        </SettingsField>

        <SettingsField label={t('profile.bio')} hint={t('profile.bioHint')} htmlFor="ob-profile-bio">
          <textarea
            id="ob-profile-bio"
            value={bio}
            rows={3}
            placeholder={t('profile.bioPlaceholder')}
            className={cn(inputVariants(), 'min-h-[72px] resize-y px-3 py-2')}
            onChange={(e) => update({profile: {bio: e.target.value}})}
          />
        </SettingsField>
      </SettingsSection>

      <SettingsSection title={t('profile.preview')}>
        <div className="flex items-center gap-3 rounded-md border border-border px-3.5 py-3">
          <ProfileAvatar profile={preferences.profile} className="h-10 w-10 text-sm [&[data-avatar-kind=emoji]]:text-xl" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium">{shownName}</span>
            {bio.trim() && <span className="truncate text-xs text-muted-foreground">{bio}</span>}
          </span>
        </div>
      </SettingsSection>
    </SettingsScreen>
  );
}
