import './index.css';

export * from './components';
export * from './data';
export * from './layouts';
export * from './providers';
export * from './screens';
export {
  SETTINGS_TABS,
  isSettingsTab,
  isTabParam,
  normalizeTab,
  SETTINGS_SECTION_PEOPLE,
  SETTINGS_ALIAS_SECTIONS,
} from './lib/hud';
export type {HudProps, SettingsTab, SettingsMode} from './lib/hud';
// The account update-check client + response mapping, consumed by the desktop
// shell's `platform.updates` implementation (and the update scheduler).
export {checkForUpdateViaAccount, mapUpdateCheckResponse, compareSemver} from './lib/updateCheck';
export type {UpdateCheckParams, UpdateCheckOptions} from './lib/updateCheck';

// Untrusted-HTML sandbox contract (no React dep) — reused by the SandboxedHtml
// component and the export pipeline.
export {SANDBOX_FLAGS, EXPORT_ARTIFACT_CSP, escapeSrcdocAttribute, wrapSandboxDocument} from './lib/srcdoc';
export {SandboxedHtml, SandboxCspContext, type SandboxedHtmlProps} from './components/SandboxedHtml';

// The custom CRDT block editor — the app's only editor. `migrateLegacyBlocks`
// still upgrades legacy stored snapshots to the block document on open.
export {BlockEditor, createDoc as createBlockDoc, createSeededDoc as createSeededBlockDoc, decodeSnapshot as decodeBlockDoc, encodeSnapshot as encodeBlockDoc, migrateLegacyBlocks, docToJSON as blockDocToJSON, type BlockDocSnapshot, type BlockJSON} from './blockeditor';
export {connectBroadcast, type BroadcastConnection, type PresencePeer} from './blockeditor';
// Live collaboration (Collab T4): the presence/awareness data layer + the registry
// the remote-cursor surface (Collab T5) reads peers/selections from.
export {connectPageAwareness, blockSelection, type AwarenessConnection, type AwarenessIdentity, type AwarenessSelection, type AwarenessState} from './blockeditor';
export {openAwareness, registerOpenAwareness, subscribeOpenAwareness} from './lib/openAwareness';
export {registerCustomBlock, registerReactiveBlocks, registerArtifactKit, blocksToHtml, blocksToMarkdown, type CustomBlockDef, type CustomBlockProps} from './blockeditor';
