import {useEffect, useState} from 'react';
import {handoffAccountToken} from '@book.dev/ui';

/**
 * The web side of account.book.pub's deep-link sign-in. The account service
 * redirects here with `#token=…&state=…`; we hand the token back to the running
 * app — over the BroadcastChannel when we're a popup (then close), or via the
 * localStorage handoff + a redirect home when sign-in ran in the same tab.
 *
 * Rendered bare (see `_app.tsx`), so no app providers mount here.
 */
export default function AccountCallback() {
  const [message, setMessage] = useState('Signing you in…');

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const token = params.get('token') ?? '';
    const state = params.get('state') ?? '';
    // Drop the token from the address bar immediately.
    history.replaceState(null, '', window.location.pathname);

    if (!token) {
      setMessage('No sign-in token was returned. You can close this window.');
      return;
    }

    const isPopup = !!window.opener && window.opener !== window;
    if (isPopup) {
      handoffAccountToken(token, state, 'broadcast');
      setMessage('Signed in. You can close this window.');
      window.close();
    } else {
      handoffAccountToken(token, state, 'storage');
      window.location.replace('/');
    }
  }, []);

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        font: '15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      }}
    >
      <p style={{color: '#6b6b6b'}}>{message}</p>
    </main>
  );
}
