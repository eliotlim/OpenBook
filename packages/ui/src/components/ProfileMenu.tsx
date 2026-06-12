import {useState} from 'react';
import {Info, UserPen} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {Button} from '@/components/ui/button';
import AboutDialog from '@/components/AboutDialog';
import {ProfileAvatar} from '@/components/ProfileAvatar';
import {useHud, usePreferences, useTranslation} from '@/providers';

/**
 * The sidebar footer is the user: avatar + name opening a small profile
 * menu — edit the profile (Settings → Profile) or read about the app.
 */
export default function ProfileMenu() {
  const {t} = useTranslation();
  const {setHud} = useHud();
  const {profile} = usePreferences().preferences;
  const [aboutOpen, setAboutOpen] = useState(false);
  const name = profile.displayName.trim() || profile.name.trim() || t('profile.anonymous');

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="flex min-w-0 grow items-center justify-start gap-2 px-1.5" data-profile-menu>
            <ProfileAvatar profile={profile} className="h-6 w-6 text-[10px] [&[data-avatar-kind=emoji]]:text-sm" />
            <span className="truncate text-sm font-medium">{name}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-64">
          <div className="flex items-center gap-3 px-2 py-2">
            <ProfileAvatar profile={profile} className="h-9 w-9 text-sm [&[data-avatar-kind=emoji]]:text-xl" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium">{name}</span>
              {profile.bio.trim() && <span className="truncate text-xs text-muted-foreground">{profile.bio}</span>}
            </span>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() =>
              setHud((draft) => {
                draft.settings.open = true;
                draft.settings.tab = 'profile';
                return draft;
              })
            }
          >
            <UserPen className="mr-2 h-4 w-4" />
            {t('profile.editProfile')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setAboutOpen(true)}>
            <Info className="mr-2 h-4 w-4" />
            {t('profile.aboutApp')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </>
  );
}
