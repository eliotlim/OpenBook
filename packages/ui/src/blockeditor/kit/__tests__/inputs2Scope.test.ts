import {describe, expect, it} from 'vitest';
import {createDoc, rootBlocks} from '../../model';
import {inputScope, inputValue, evalExpr, richTextPlain} from '../scope';
import {sectionCompletion, overallCompletion, completionRead, containerCompletions} from '../completion';

describe('June-2026 inputs publish into the scope', () => {
  it('publishes single vs multi choice cards, search-select, tags, and the long/rich text projection', () => {
    const doc = createDoc([
      {type: 'choicecards', props: {name: 'plan', opts: [{label: 'Free'}, {label: 'Pro'}], value: 'pro'}},
      {type: 'choicecards', props: {name: 'addons', multi: true, opts: [{label: 'A'}, {label: 'B'}], selected: ['a', 'b']}},
      {type: 'searchselect', props: {name: 'country', value: 'us'}},
      {type: 'searchselect', props: {name: 'langs', multi: true, selected: ['en', 'fr']}},
      {type: 'tagfield', props: {name: 'topics', selected: ['ai', 'ml']}},
      {type: 'longtext', props: {name: 'notes', value: 'hello\nworld'}},
      {type: 'richtext', props: {name: 'bio', runs: [{t: 'Hi '}, {t: 'there', a: {b: true}}]}},
    ]);
    const scope = inputScope(doc);
    expect(scope).toMatchObject({
      plan: 'pro',
      addons: ['a', 'b'],
      country: 'us',
      langs: ['en', 'fr'],
      topics: ['ai', 'ml'],
      notes: 'hello\nworld',
      bio: 'Hi there', // plain-text projection, markup dropped
    });
    // The published values are usable in expressions / charts.
    expect(evalExpr('addons.length + langs.length + topics.length', scope).value).toBe(6);
  });

  it('projects rich-text runs to plain text', () => {
    const doc = createDoc([{type: 'richtext', props: {runs: [{t: 'a'}, {t: 'b', a: {i: true}}]}}]);
    expect(richTextPlain(rootBlocks(doc).get(0))).toBe('ab');
    expect(inputValue(rootBlocks(doc).get(0))).toBe('ab');
  });

  it('namespaces the new inputs inside a group like the originals', () => {
    const doc = createDoc([
      {
        type: 'group',
        props: {name: 'Signup'},
        children: [
          {type: 'tagfield', props: {name: 'tags', selected: ['x']}},
          {type: 'longtext', props: {label: 'Why', value: 'because'}},
        ],
      },
    ]);
    const scope = inputScope(doc);
    expect(scope.signup).toEqual({tags: {value: ['x']}, why: {value: 'because'}});
  });
});

describe('container completion (auto-computed reads)', () => {
  const wizard = () =>
    createDoc([
      {
        type: 'accordion',
        props: {name: 'setup'},
        children: [
          {
            type: 'accordionsection',
            props: {label: 'A'},
            children: [
              {type: 'textfield', props: {name: 'a1', value: 'filled'}},
              {type: 'todo', props: {checked: true}, text: 'done'},
            ],
          },
          {
            type: 'accordionsection',
            props: {label: 'B'},
            children: [
              {type: 'number', props: {name: 'b1', value: 5}},
              {type: 'toggle', props: {name: 'b2', value: false}}, // not filled (false)
            ],
          },
        ],
      },
    ]);

  it('counts filled inputs and checked to-dos per section', () => {
    const acc = rootBlocks(wizard()).get(0);
    const sections = acc.get('children') as { get: (i: number) => Parameters<typeof sectionCompletion>[0] };
    const a = sectionCompletion(sections.get(0));
    expect(a).toMatchObject({total: 2, done: 2, complete: true});
    const b = sectionCompletion(sections.get(1));
    expect(b).toMatchObject({total: 2, done: 1, complete: false});
    expect(b.ratio).toBe(0.5);
  });

  it('aggregates overall completion across sections', () => {
    const acc = rootBlocks(wizard()).get(0);
    expect(overallCompletion(acc)).toMatchObject({total: 4, done: 3, complete: false});
  });

  it('exposes a completion read with per-section detail', () => {
    const acc = rootBlocks(wizard()).get(0);
    const read = completionRead(acc);
    expect(read.sections).toHaveLength(2);
    expect(read.sections[0].complete).toBe(true);
    expect(read.sections[1].complete).toBe(false);
  });

  it('injects the completion read into the input scope under the container name', () => {
    const doc = wizard();
    const scope = inputScope(doc) as {setup: {complete: boolean; ratio: number; done: number; total: number}};
    expect(scope.setup.total).toBe(4);
    expect(scope.setup.done).toBe(3);
    expect(scope.setup.complete).toBe(false);
    // A progress bar binds this read directly.
    expect(evalExpr('setup.ratio', scope).value).toBeCloseTo(0.75);
    expect(evalExpr('setup.complete', scope).value).toBe(false);
  });

  it('keys multiple containers by their names', () => {
    const doc = createDoc([
      {type: 'tabs', props: {name: 'wizardA'}, children: [{type: 'tab', props: {label: 'T'}, children: [{type: 'toggle', props: {name: 'x', value: true}}]}]},
      {type: 'accordion', props: {name: 'wizardB'}, children: [{type: 'accordionsection', props: {label: 'S'}, children: [{type: 'toggle', props: {name: 'y', value: false}}]}]},
    ]);
    const reads = containerCompletions(doc);
    expect(reads.wizardA.complete).toBe(true);
    expect(reads.wizardB.complete).toBe(false);
  });

  it('a real input wins a name collision with a container completion', () => {
    const doc = createDoc([
      {type: 'tabs', props: {name: 'dup'}, children: [{type: 'tab', props: {label: 'T'}, children: [{type: 'toggle', props: {name: 'z', value: true}}]}]},
      {type: 'number', props: {name: 'dup', value: 42}},
    ]);
    expect(inputScope(doc).dup).toBe(42);
  });
});
