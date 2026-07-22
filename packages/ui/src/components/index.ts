export * from './brand';
export {default as Drawer} from './Drawer';
export {default as NavBar} from './NavBar';
export {default as SideNav} from './SideNav';
export {default as TrashDialog} from './TrashDialog';
export {default as DocumentArea} from './DocumentArea';
export {default as TitlebarTabs} from './TitlebarTabs';
// WindowControls (the component) is intentionally not re-exported: it is used
// only by DefaultLayout, and the public name `WindowControls` is the platform
// type from the providers.
export {DatabaseView} from './database/DatabaseView';
export {useDatabase} from './database/useDatabase';
export {default as Settings} from './Settings';
export {default as SettingsPanel} from './SettingsPanel';
export {default as SettingsButton} from './SettingsButton';
// The reusable sandboxed renderer for untrusted HTML artifacts (opaque-origin
// iframe). Security posture lives in lib/srcdoc.
export {SandboxedHtml, type SandboxedHtmlProps} from './SandboxedHtml';
// App/page render-crash recovery (STAB-3): the reusable boundary + its
// design-system fallback UI. The desktop shell wraps the whole app in one; the
// page document wraps itself in another so a poisoned page can't take down nav.
export {ErrorBoundary, ErrorFallback, type ErrorBoundaryProps, type ErrorFallbackProps} from './ErrorBoundary';
