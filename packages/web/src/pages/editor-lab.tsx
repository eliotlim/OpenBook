import dynamic from 'next/dynamic';

/**
 * The block editor sandbox: a standalone page for building and testing the
 * custom CRDT editor without touching real workspace pages. The document
 * lives in localStorage and syncs live across tabs (open two windows side
 * by side to watch the CRDT merge).
 */
const EditorLab = dynamic(() => import('../components/EditorLab'), {ssr: false});

export default function EditorLabPage() {
  return <EditorLab />;
}
