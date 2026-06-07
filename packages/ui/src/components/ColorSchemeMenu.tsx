import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {Button} from '@/components/ui/button';
import {SunIcon} from '@heroicons/react/24/outline';
import {MoonIcon, DesktopIcon} from '@radix-ui/react-icons';
import {ColorMode, useTheme, useTranslation} from '@/providers';

export default function ColorSchemeMenu() {
  const {mode, setMode} = useTheme();
  const {t} = useTranslation();

  const icon = mode === 'light' ? <SunIcon className="h-4 w-4" /> : mode === 'dark' ? <MoonIcon className="h-4 w-4" /> : <DesktopIcon className="h-4 w-4" />;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-8 px-2 text-muted-foreground hover:text-foreground"
          aria-label={t('appearance.colorScheme')}
        >
          {icon}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>{t('appearance.title')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={mode} onValueChange={(e) => setMode(e as ColorMode)}>
          <DropdownMenuRadioItem value="light">{t('appearance.light')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">{t('appearance.dark')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">{t('appearance.system')}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
