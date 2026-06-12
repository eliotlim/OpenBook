import {describe, expect, it} from 'vitest';
import {createDoc, type NewBlock} from '../../blockeditor/model';
import {pagePluginFiles, pageHasPluginManifest, pageToPluginZip} from '../pagePlugin';
import {parsePluginZip} from '../loader';

const MANIFEST = {id: 'acme.page', name: 'Page Authored', version: '1.0.0', main: 'src/index.ts'};

const manifestBlock = (json: object | string): NewBlock => ({
  type: 'code',
  text: typeof json === 'string' ? json : JSON.stringify(json),
  props: {name: 'openbook.json', language: 'json'},
});

describe('page → plugin export', () => {
  it('collects named non-live code blocks as files, in document order', () => {
    const doc = createDoc([
      {type: 'paragraph', text: 'Prose explaining the plugin.'},
      manifestBlock(MANIFEST),
      {type: 'code', text: 'export default () => {};', props: {name: 'src/index.ts'}},
      {type: 'code', text: 'unnamed snippet'},
      {type: 'code', text: '1 + 1', props: {name: 'total', live: true}},
    ]);
    const files = pagePluginFiles(doc);
    expect([...files.keys()]).toEqual(['openbook.json', 'src/index.ts']);
    expect(pageHasPluginManifest(doc)).toBe(true);
  });

  it('zips an installable package that round-trips through parsePluginZip', () => {
    const doc = createDoc([
      manifestBlock(MANIFEST),
      {type: 'code', text: 'export default function activate(api) {}', props: {name: 'src/index.ts'}},
      {type: 'code', text: 'export const x = 1;', props: {name: 'src/util.ts'}},
    ]);
    const {filename, bytes} = pageToPluginZip(doc);
    expect(filename).toBe('acme.page-1.0.0.zip');
    const pkg = parsePluginZip(bytes);
    expect(pkg.manifest).toEqual(MANIFEST);
    expect(Object.keys(pkg.files).sort()).toEqual(['src/index.ts', 'src/util.ts']);
    expect(pkg.files['src/index.ts']).toBe('export default function activate(api) {}');
  });

  it('rejects a page without a manifest, bad JSON, and a missing entry file', () => {
    expect(() => pageToPluginZip(createDoc([{type: 'code', text: 'x', props: {name: 'src/index.ts'}}]))).toThrow(/openbook\.json/);
    expect(() => pageToPluginZip(createDoc([manifestBlock('{nope')]))).toThrow(/not valid JSON/);
    expect(() => pageToPluginZip(createDoc([manifestBlock(MANIFEST)]))).toThrow(/src\/index\.ts/);
    expect(() => pageToPluginZip(createDoc([manifestBlock({...MANIFEST, id: 'NoDots'})]))).toThrow(/publisher/);
  });
});
