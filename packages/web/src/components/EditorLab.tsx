import React, {useEffect, useMemo, useState} from 'react';
import {
  BlockEditor,
  connectBroadcast,
  registerReactiveBlocks,
  registerArtifactKit,
  createSeededBlockDoc,
  decodeBlockDoc,
  encodeBlockDoc,
  type BlockDocSnapshot,
  type PresencePeer,
} from '@open-book/ui';

const STORAGE_KEY = 'obe-lab-doc';

registerReactiveBlocks();
registerArtifactKit();

/** The sandbox shell around the block editor (localStorage + tab sync). */
export default function EditorLab() {
  const doc = useMemo(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return decodeBlockDoc(JSON.parse(raw) as BlockDocSnapshot);
    } catch {
      // corrupted sandbox state — start fresh
    }
    // Seeded deterministically: two tabs racing to initialize merge into one
    // copy of the demo content instead of duplicating it.
    return createSeededBlockDoc([
      {type: 'heading', text: 'Editor lab', props: {level: 1}},
      {type: 'paragraph', text: 'A scratch document for the new editor. Type “/” for blocks, select text to format, drag the ⠿ handle — drop a block beside another to make columns.'},
      {type: 'todo', text: 'Open this page in a second window to watch live sync'},
    ]);
  }, []);

  const [peers, setPeers] = useState<PresencePeer[]>([]);

  useEffect(() => {
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const onUpdate = (): void => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(encodeBlockDoc(doc)));
      }, 400);
    };
    doc.on('update', onUpdate);
    const conn = connectBroadcast(doc, 'editor-lab', `Tab ${String(doc.clientID).slice(-3)}`);
    const offPeers = conn.onPeers(setPeers);
    return () => {
      doc.off('update', onUpdate);
      offPeers();
      conn.disconnect();
      if (saveTimer) clearTimeout(saveTimer);
    };
  }, [doc]);

  return (
    <div style={{minHeight: '100vh', background: 'hsl(var(--background))'}}>
      <div style={{maxWidth: '44rem', margin: '0 auto', padding: '3rem 1.5rem 0'}}>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem'}}>
          <span style={{fontSize: 12, color: 'hsl(var(--muted-foreground))'}}>editor lab · synced across tabs</span>
          <span style={{display: 'flex', gap: 6}}>
            {peers.map((p) => (
              <span
                key={p.clientId}
                title={p.name}
                style={{width: 10, height: 10, borderRadius: 999, background: p.color, display: 'inline-block'}}
              />
            ))}
          </span>
        </div>
      </div>
      <BlockEditor doc={doc} ariaLabel="Editor lab document" />
    </div>
  );
}
