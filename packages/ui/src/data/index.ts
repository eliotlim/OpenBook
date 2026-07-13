// React bindings for the data layer. Types and the HTTP client live in
// `@book.dev/sdk`; import those directly from there.
export {
  DataProvider,
  useData,
  useOptionalData,
  usePagePersistence,
  useCurrentPageId,
  getOrCreateCurrentPageId,
} from './DataProvider';
