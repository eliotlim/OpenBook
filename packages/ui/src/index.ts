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
// The provider-independent translator is also used by shell-level recovery UI,
// which renders above I18nProvider and therefore cannot consume its hook.
export {t} from './i18n';
// The account update-check client + response mapping, consumed by the desktop
// shell's `platform.updates` implementation (and the update scheduler).
export {checkForUpdateViaAccount, mapUpdateCheckResponse, compareSemver} from './lib/updateCheck';
export type {UpdateCheckParams, UpdateCheckOptions} from './lib/updateCheck';

// Untrusted-HTML sandbox contract (no React dep) — reused by the SandboxedHtml
// component and the export pipeline.
export {SANDBOX_FLAGS, EXPORT_ARTIFACT_CSP, escapeSrcdocAttribute, wrapSandboxDocument} from './lib/srcdoc';

// Home pseudo-page id + crash-loop recovery (STAB-3): the desktop shell's
// app-level error boundary sends the user Home and forgets the last page so a
// reload doesn't re-poison itself; the page boundary quarantines the offending
// page id (readCrashedPages skips it at startup).
export {HOME_PAGE_ID} from './lib/homePage';
export {markPageCrashed, readCrashedPages, isPageCrashed, clearCrashedPage} from './lib/crashRecovery';
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

// Interactive HTML export: projects a page snapshot into a self-contained,
// offline-capable HTML file with the reactive runtime (sliders/charts/formulas)
// inlined. `toSlideDeck`/`toHtmlSite` are the deck + multi-page variants.
export {toHtml, toSlideDeck, toHtmlSite} from './export/toHtml';
