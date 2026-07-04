import './index.css';

export * from './components';
export * from './data';
export * from './layouts';
export * from './providers';
export * from './screens';
export {SETTINGS_TABS, isSettingsTab} from './lib/hud';
export type {HudProps, SettingsTab, SettingsMode} from './lib/hud';

// Untrusted-HTML sandbox contract (no React dep) — reused by the SandboxedHtml
// component and, later, the export pipeline's string-built iframes.
export {SANDBOX_FLAGS, escapeSrcdocAttribute, wrapSandboxDocument} from './lib/srcdoc';

// The custom CRDT block editor — the app's only editor. `migrateEditorJs` still
// upgrades legacy EditorJS snapshots to the block document on open.
export {BlockEditor, createDoc as createBlockDoc, createSeededDoc as createSeededBlockDoc, decodeSnapshot as decodeBlockDoc, encodeSnapshot as encodeBlockDoc, migrateEditorJs, docToJSON as blockDocToJSON, type BlockDocSnapshot, type BlockJSON} from './blockeditor';
export {connectBroadcast, type BroadcastConnection, type PresencePeer} from './blockeditor';
// Live collaboration (Collab T4): the presence/awareness data layer + the registry
// the remote-cursor surface (Collab T5) reads peers/selections from.
export {connectPageAwareness, blockSelection, type AwarenessConnection, type AwarenessIdentity, type AwarenessSelection, type AwarenessState} from './blockeditor';
export {openAwareness, registerOpenAwareness, subscribeOpenAwareness} from './lib/openAwareness';
export {registerCustomBlock, registerReactiveBlocks, registerArtifactKit, blocksToHtml, blocksToMarkdown, type CustomBlockDef, type CustomBlockProps} from './blockeditor';
