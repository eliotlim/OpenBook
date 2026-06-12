import React from 'react';

/**
 * A custom block is just a React component over CRDT props: read with
 * `blockProp`-style access via the props the host passes, write through the
 * editor transaction — here simplified to the host-provided helpers.
 */
export const HelloBlock = ({block, editor}: {block: {get(k: string): unknown}; editor: {doc: {transact(fn: () => void, origin: string): void}; readOnly: boolean}}) => {
  const props = block.get('props') as {get(k: string): unknown; set(k: string, v: unknown): void} | undefined;
  const count = Number(props?.get('count') ?? 0);

  return (
    <div
      data-hello-block
      style={{display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.5rem 0.75rem', border: '1px solid hsl(var(--border))', borderRadius: 8}}
      contentEditable={false}
    >
      <span style={{fontSize: '1.2rem'}}>👋</span>
      <span style={{fontSize: '0.9rem'}}>Hello from a plugin! Clicked {count} times.</span>
      <button
        type="button"
        disabled={editor.readOnly}
        style={{marginLeft: 'auto', border: '1px solid hsl(var(--border))', borderRadius: 6, padding: '0.15rem 0.6rem', cursor: 'pointer', background: 'hsl(var(--card))'}}
        onClick={() => editor.doc.transact(() => props?.set('count', count + 1), 'local')}
      >
        +1
      </button>
    </div>
  );
};
