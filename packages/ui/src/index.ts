import './index.css';

export * from './components';
export * from './data';
export * from './layouts';
export * from './providers';
export * from './screens';
export {store, type ReactiveStore} from './reactive/ReactiveStore';
export {reactiveTools} from './reactive';
export {SETTINGS_TABS, isSettingsTab} from './lib/hud';
export type {HudProps, SettingsTab, SettingsMode} from './lib/hud';

// The custom CRDT block editor (parallel to the EditorJS surface during migration).
export {BlockEditor, createDoc as createBlockDoc, createSeededDoc as createSeededBlockDoc, decodeSnapshot as decodeBlockDoc, encodeSnapshot as encodeBlockDoc, migrateEditorJs, docToJSON as blockDocToJSON, type BlockDocSnapshot, type BlockJSON} from './blockeditor';
export {connectBroadcast, type BroadcastConnection, type PresencePeer} from './blockeditor';
export {registerCustomBlock, registerReactiveBlocks, blocksToHtml, blocksToMarkdown, type CustomBlockDef, type CustomBlockProps} from './blockeditor';
