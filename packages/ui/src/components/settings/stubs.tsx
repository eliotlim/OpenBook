import {PersonIcon, HeartIcon, MixIcon} from '@radix-ui/react-icons';
import {useTranslation} from '@/providers';
import {SettingsStub} from '@/components/settings/primitives';

/**
 * Placeholder screens for capabilities that don't exist yet — OpenBook is
 * local-first, with no accounts, payments, or integrations backend. Each is a
 * calm "coming soon" panel rather than a misleading empty form.
 */

export function SignupSettings() {
  const {t} = useTranslation();
  return (
    <SettingsStub icon={PersonIcon} title={t('account.signup.title')} description={t('account.signup.description')} />
  );
}

export function SupportSettings() {
  const {t} = useTranslation();
  return (
    <SettingsStub icon={HeartIcon} title={t('account.support.title')} description={t('account.support.description')} />
  );
}

export function IntegrationsSettings() {
  const {t} = useTranslation();
  return (
    <SettingsStub icon={MixIcon} title={t('integrations.title')} description={t('integrations.description')} />
  );
}
