import {useEffect} from 'react';
import {useNavigation} from '@/providers';

/**
 * Keeps the document (browser-tab / window) title in sync with the current
 * page, so tabs read "Sprint board · OpenBook" instead of all being "OpenBook".
 * Runs on every render — the label can change through rename flows that don't
 * change identity-stable deps, and assignment is trivially cheap.
 */
export default function WindowTitle() {
  const {currentPageId, pageLabel} = useNavigation();
  useEffect(() => {
    const name = (currentPageId ? pageLabel(currentPageId) : '')?.trim();
    document.title = name ? `${name} · OpenBook` : 'OpenBook';
  });
  return null;
}
