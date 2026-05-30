import {describe, it, expect, beforeEach} from 'vitest';
import {effect} from '@preact/signals-core';
import {ReactiveStore} from '../ReactiveStore';

describe('ReactiveStore', () => {
  let store: ReactiveStore;

  beforeEach(() => {
    store = new ReactiveStore();
  });

  it('lazy-creates a Signal on first read and returns undefined', () => {
    expect(store.getByCellId('cell-new')).toBeUndefined();
    // After the read, the Signal exists in the internal map so subsequent
    // reads also return undefined without re-creating.
    expect(store.getByCellId('cell-new')).toBeUndefined();
  });

  it('setByCellId updates an existing Signal\'s value', () => {
    store.setByCellId('cell-a', 1);
    expect(store.getByCellId('cell-a')).toBe(1);
    store.setByCellId('cell-a', 2);
    expect(store.getByCellId('cell-a')).toBe(2);
  });

  it('setByCellId triggers subscribed effects to re-run', () => {
    let observed: unknown = 'initial';
    store.setByCellId('cell-b', 10);
    const dispose = effect(() => {
      observed = store.getByCellId('cell-b');
    });
    expect(observed).toBe(10);
    store.setByCellId('cell-b', 20);
    expect(observed).toBe(20);
    dispose();
  });

  it('deleteCell sets value to undefined and removes from name index BUT keeps the Signal object (StrictMode regression guard)', () => {
    store.setByCellId('cell-c', 'hello');
    store.setName('cell-c', 'greeting');
    expect(store.getByCellId('cell-c')).toBe('hello');
    expect(store.getIdByName('greeting')).toBe('cell-c');

    // Subscribe BEFORE delete.
    let observed: unknown = 'never';
    const dispose = effect(() => {
      observed = store.getByCellId('cell-c');
    });
    expect(observed).toBe('hello');

    store.deleteCell('cell-c');
    // Value is now undefined; the subscriber observed it.
    expect(observed).toBeUndefined();
    expect(store.getIdByName('greeting')).toBeUndefined();

    // CRITICAL: Re-setting the same cellId must reach the SAME subscriber.
    // If the Signal object were dropped on delete, the subscriber would
    // still hold the old reference and miss this update.
    store.setByCellId('cell-c', 'reborn');
    expect(observed).toBe('reborn');
    dispose();
  });

  it('setName removes the old name from the index when a cellId is renamed', () => {
    store.setName('cell-d', 'first');
    expect(store.getIdByName('first')).toBe('cell-d');
    expect(store.getName('cell-d')).toBe('first');

    store.setName('cell-d', 'second');
    expect(store.getIdByName('second')).toBe('cell-d');
    expect(store.getIdByName('first')).toBeUndefined();
    expect(store.getName('cell-d')).toBe('second');
  });

  it('snapshot + hydrate round-trips state without loss', () => {
    store.setByCellId('cell-x', 100);
    store.setByCellId('cell-y', [1, 2, 3]);
    store.setName('cell-x', 'price');
    store.setName('cell-y', 'series');

    const snap = store.snapshot();
    expect(snap.values).toContainEqual(['cell-x', 100]);
    expect(snap.values).toContainEqual(['cell-y', [1, 2, 3]]);
    expect(snap.names).toContainEqual(['price', 'cell-x']);
    expect(snap.names).toContainEqual(['series', 'cell-y']);

    const fresh = new ReactiveStore();
    fresh.hydrate(snap);
    expect(fresh.getByCellId('cell-x')).toBe(100);
    expect(fresh.getByCellId('cell-y')).toEqual([1, 2, 3]);
    expect(fresh.getIdByName('price')).toBe('cell-x');
    expect(fresh.getIdByName('series')).toBe('cell-y');
  });
});
