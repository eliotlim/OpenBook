import {useEffect} from 'react';
import {ICON_PROPERTY_ID} from '@book.dev/sdk';
import {useData} from '@/data';
import {hydratePageAppearance, setAppearanceBackend} from '@/lib/pageAppearance';
import {setIconPersister} from '@/lib/pageIcon';

/**
 * Wires the per-page appearance store (lib/pageAppearance) and the icon store
 * (lib/pageIcon) to the data client: writes persist a page's theme / cover /
 * typefaces / full-width / icon onto `page.properties`, and a lazy load hydrates
 * the appearance cache the first time a page's appearance is read. Renders
 * nothing. Mounted once at the app root (alongside AiBridgeHost).
 */
export function PageAppearanceHost() {
  const client = useData();
  useEffect(() => {
    setAppearanceBackend({
      persist: (pageId, propertyKey, value) => {
        void client.setPageProperties(pageId, {[propertyKey]: value}).catch(() => undefined);
      },
      load: (pageId) => {
        void client
          .getPage(pageId)
          .then((p) => hydratePageAppearance(pageId, p?.properties))
          .catch(() => undefined);
      },
    });
    setIconPersister((pageId, emoji) => {
      void client.setPageProperties(pageId, {[ICON_PROPERTY_ID]: emoji}).catch(() => undefined);
    });
    return () => {
      setAppearanceBackend(null);
      setIconPersister(null);
    };
  }, [client]);
  return null;
}

export default PageAppearanceHost;
