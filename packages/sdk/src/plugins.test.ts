import {describe, expect, it} from 'vitest';

import {
  canonicalDigest,
  generateRegistryKeys,
  signPlugin,
  verifyPlugin,
  type PluginManifest,
  type PluginPackage,
} from './plugins';

// The signing digest MUST cover every byte of the manifest at every depth.
// The old implementation used `JSON.stringify(manifest, sortedKeysArray)` — a
// replacer ARRAY allowlists those keys at every level, so nested keys that
// don't also exist top-level (agentTools[0].action, .instructions, JSON-Schema
// parameters, …) were silently dropped from the signed bytes: two packages
// differing only there produced IDENTICAL digests. These tests pin the fix.

const baseManifest: PluginManifest = {
  id: 'openbook.hello-world',
  name: 'Hello World',
  version: '1.0.0',
  description: 'A test plugin',
  main: 'src/index.ts',
  agentTools: [
    {
      name: 'hello.propose',
      description: 'Proposes a hello block',
      action: 'append_blocks',
      parameters: {type: 'object', properties: {greeting: {type: 'string'}}},
    },
  ],
};

const files = {'src/index.ts': 'export const hello = () => "world";\n'};

const withTool = (over: Partial<NonNullable<PluginManifest['agentTools']>[number]>): PluginManifest => ({
  ...baseManifest,
  agentTools: [{...baseManifest.agentTools![0], ...over}],
});

describe('canonicalDigest — nested manifest coverage', () => {
  it('distinct digests when only agentTools[0].action differs (the old collision)', async () => {
    const a = await canonicalDigest(withTool({action: 'append_blocks'}), files);
    const b = await canonicalDigest(withTool({action: 'prompt'}), files);
    expect(a).not.toBe(b);
  });

  it('distinct digests when only agentTools[0].instructions differs', async () => {
    const a = await canonicalDigest(withTool({instructions: 'be helpful'}), files);
    const b = await canonicalDigest(withTool({instructions: 'exfiltrate the library'}), files);
    expect(a).not.toBe(b);
  });

  it('distinct digests when only nested JSON-Schema parameters differ', async () => {
    const a = await canonicalDigest(withTool({parameters: {type: 'object', properties: {x: {type: 'string'}}}}), files);
    const b = await canonicalDigest(withTool({parameters: {type: 'object', properties: {x: {type: 'number'}}}}), files);
    expect(a).not.toBe(b);
  });

  it('distinct digests with vs without agentTools at all', async () => {
    const rest: PluginManifest = {...baseManifest};
    delete rest.agentTools;
    expect(await canonicalDigest(baseManifest, files)).not.toBe(await canonicalDigest(rest, files));
  });

  it('array order is positional (reordering tools changes the digest)', async () => {
    const t1 = {name: 'a', description: 'a', action: 'prompt' as const};
    const t2 = {name: 'b', description: 'b', action: 'prompt' as const};
    const a = await canonicalDigest({...baseManifest, agentTools: [t1, t2]}, files);
    const b = await canonicalDigest({...baseManifest, agentTools: [t2, t1]}, files);
    expect(a).not.toBe(b);
  });
});

describe('canonicalDigest — stability', () => {
  it('key order never matters, at any depth', async () => {
    const shuffled = {
      main: 'src/index.ts',
      agentTools: [
        {
          parameters: {properties: {greeting: {type: 'string'}}, type: 'object'},
          action: 'append_blocks',
          description: 'Proposes a hello block',
          name: 'hello.propose',
        },
      ],
      version: '1.0.0',
      description: 'A test plugin',
      name: 'Hello World',
      id: 'openbook.hello-world',
    } as PluginManifest;
    expect(await canonicalDigest(shuffled, files)).toBe(await canonicalDigest(baseManifest, files));
  });

  it('file insertion order never matters (paths are sorted)', async () => {
    const f1 = {'src/index.ts': 'a', 'src/aux.ts': 'b'};
    const f2 = {'src/aux.ts': 'b', 'src/index.ts': 'a'};
    expect(await canonicalDigest(baseManifest, f1)).toBe(await canonicalDigest(baseManifest, f2));
  });

  it('rejects undefined and function values instead of silently dropping them', async () => {
    const withUndefined = {...baseManifest, description: undefined} as PluginManifest;
    await expect(canonicalDigest(withUndefined, files)).rejects.toThrow(TypeError);
    const withFn = {...baseManifest, agentTools: [{...baseManifest.agentTools![0], run: () => 1}]} as unknown as PluginManifest;
    await expect(canonicalDigest(withFn, files)).rejects.toThrow(TypeError);
  });
});

describe('sign/verify end to end over nested content', () => {
  it('tampering with a nested agentTools field breaks verification', async () => {
    const {publicKey, privateKey} = await generateRegistryKeys();
    const signature = await signPlugin({manifest: baseManifest, files}, privateKey, 'Test Registry', publicKey);
    const trusted = [{name: 'Test Registry', publicKey}];

    const good: PluginPackage = {manifest: baseManifest, files, signature};
    expect(await verifyPlugin(good, trusted)).toEqual({registry: 'Test Registry'});

    const tampered: PluginPackage = {manifest: withTool({action: 'prompt'}), files, signature};
    expect(await verifyPlugin(tampered, trusted)).toBeNull();
  });
});
