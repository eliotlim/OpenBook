// React bindings for the data layer. Types and the HTTP client live in
// `@open-book/sdk`; import those directly from there.
export {
  DataProvider,
  useData,
  usePagePersistence,
  useCurrentPageId,
  getOrCreateCurrentPageId,
} from './DataProvider';
