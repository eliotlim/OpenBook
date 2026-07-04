import dynamic from 'next/dynamic';

/**
 * INTERNAL DEV HARNESS (not linked from the app).
 *
 * GATE OR DELETE BEFORE GA — the htmlArtifact block view supersedes this page
 * as the product surface; it exists only so the SandboxedHtml renderer's
 * cross-origin isolation can be exercised by a browser e2e (jsdom can't run
 * iframe scripts). Mirrors /editor-lab (client-only, no SSR). When it goes,
 * repoint packages/web/e2e/sandboxed-html.spec.ts at the block view first.
 */
const SandboxLab = dynamic(() => import('../components/SandboxLab'), {ssr: false});

export default function SandboxLabPage() {
  return <SandboxLab />;
}
