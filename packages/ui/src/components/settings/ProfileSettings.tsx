import {Input, inputVariants} from '@/components/ui/input';
import {IconPicker} from '@/components/IconPicker';
import {usePreferences, useTranslation} from '@/providers';
import {cn} from '@/lib/utils';
import {SettingsScreen, SettingsSection, SettingsField} from '@/components/settings/primitives';

/** The user's local identity: name, display name, avatar emoji, and a short bio. */
export default function ProfileSettings() {
  const {t} = useTranslation();
  const {preferences, update} = usePreferences();
  const {name, displayName, avatar, bio} = preferences.profile;

  const shownName = displayName.trim() || name.trim() || t('profile.anonymous');

  return (
    <SettingsScreen title={t('profile.title')} description={t('profile.description')}>
      <SettingsSection title={t('profile.identity')}>
        <div className="flex gap-3">
          <SettingsField label={t('profile.avatar')} htmlFor="ob-profile-avatar" className="w-20">
            <IconPicker
              id="ob-profile-avatar"
              value={avatar}
              onPick={(emoji) => update({profile: {avatar: emoji}})}
              ariaLabel={t('profile.avatar')}
              fallback="🙂"
              className="flex h-9 w-full items-center justify-center rounded-md border border-input bg-transparent text-lg transition-colors hover:bg-accent"
            />
          </SettingsField>
          <SettingsField label={t('profile.name')} hint={t('profile.nameHint')} htmlFor="ob-profile-name" className="flex-1">
            <Input
              id="ob-profile-name"
              value={name}
              placeholder={t('profile.namePlaceholder')}
              onChange={(e) => update({profile: {name: e.target.value}})}
            />
          </SettingsField>
        </div>

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
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-xl leading-none">
            {avatar}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium">{shownName}</span>
            {bio.trim() && <span className="truncate text-xs text-muted-foreground">{bio}</span>}
          </span>
        </div>
      </SettingsSection>
    </SettingsScreen>
  );
}
