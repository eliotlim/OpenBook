import dynamic from 'next/dynamic';

/**
 * INTERNAL DEV HARNESS (not linked from the app). A standalone page that mounts
 * the reusable SandboxedHtml renderer with untrusted-HTML fixtures so its real
 * cross-origin isolation can be exercised in a browser e2e — jsdom can't run
 * iframe scripts. Mirrors /editor-lab (client-only, no SSR). Safe to delete
 * once a real HTML-artifact block ships and carries the e2e coverage.
 */
const SandboxLab = dynamic(() => import('../components/SandboxLab'), {ssr: false});

export default function SandboxLabPage() {
  return <SandboxLab />;
}
