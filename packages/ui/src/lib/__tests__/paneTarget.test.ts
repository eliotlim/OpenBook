import {describe, it, expect, beforeEach} from 'vitest';
import {PANE_TARGET_STORES, paneHasTarget} from '../paneTarget';
import {CONFIG_PANE_ID, AGENT_PANE_ID, CUSTOMISE_PANE_ID, FLOW_PANE_ID, GRAPH_PANE_ID, HISTORY_PANE_ID, LINKS_PANE_ID, REVIEW_PANE_ID} from '../homePage';
import {getPageCustomiseTarget, setPageCustomiseTarget} from '../pageCustomise';
import {getReviewTarget, setReviewTarget} from '../reviewPane';
import {getHistoryTarget, setHistoryTarget} from '../historyPane';
import {getLinksTarget, setLinksTarget} from '../linksPane';
import {getGraphTarget, setGraphTarget} from '../graphPane';

beforeEach(() => {
  setPageCustomiseTarget(null);
  setReviewTarget(null);
  setHistoryTarget(null);
  setLinksTarget(null);
  setGraphTarget(null);
});

describe('paneHasTarget', () => {
  it('is true only for the page-targeting side panes', () => {
    expect(paneHasTarget(CUSTOMISE_PANE_ID)).toBe(true);
    expect(paneHasTarget(REVIEW_PANE_ID)).toBe(true);
    expect(paneHasTarget(HISTORY_PANE_ID)).toBe(true);
    expect(paneHasTarget(LINKS_PANE_ID)).toBe(true);
    expect(paneHasTarget(GRAPH_PANE_ID)).toBe(true);
  });

  it('is false for ephemeral / page panes and nullish ids', () => {
    expect(paneHasTarget(CONFIG_PANE_ID)).toBe(false);
    expect(paneHasTarget(AGENT_PANE_ID)).toBe(false);
    expect(paneHasTarget(FLOW_PANE_ID)).toBe(false);
    expect(paneHasTarget('some-page-id')).toBe(false);
    expect(paneHasTarget(null)).toBe(false);
    expect(paneHasTarget(undefined)).toBe(false);
  });
});

describe('PANE_TARGET_STORES', () => {
  it('customise maps to the pageCustomise store (round-trips)', () => {
    PANE_TARGET_STORES[CUSTOMISE_PANE_ID].set('p1');
    expect(getPageCustomiseTarget()).toBe('p1');
    expect(PANE_TARGET_STORES[CUSTOMISE_PANE_ID].get()).toBe('p1');
  });

  it('review maps to the reviewPane store (round-trips)', () => {
    PANE_TARGET_STORES[REVIEW_PANE_ID].set('p2');
    expect(getReviewTarget().pageId).toBe('p2');
    expect(PANE_TARGET_STORES[REVIEW_PANE_ID].get()).toBe('p2');
  });

  it('history maps to the historyPane store (round-trips)', () => {
    PANE_TARGET_STORES[HISTORY_PANE_ID].set('p5');
    expect(getHistoryTarget().pageId).toBe('p5');
    expect(PANE_TARGET_STORES[HISTORY_PANE_ID].get()).toBe('p5');
  });

  it('links maps to the linksPane store (round-trips)', () => {
    PANE_TARGET_STORES[LINKS_PANE_ID].set('p6');
    expect(getLinksTarget().pageId).toBe('p6');
    expect(PANE_TARGET_STORES[LINKS_PANE_ID].get()).toBe('p6');
  });

  it('graph maps to the graphPane store (round-trips)', () => {
    PANE_TARGET_STORES[GRAPH_PANE_ID].set('p7');
    expect(getGraphTarget().pageId).toBe('p7');
    expect(PANE_TARGET_STORES[GRAPH_PANE_ID].get()).toBe('p7');
  });

  it('notifies subscribers when a target changes', () => {
    let hits = 0;
    const unsub = PANE_TARGET_STORES[CUSTOMISE_PANE_ID].subscribe(() => (hits += 1));
    PANE_TARGET_STORES[CUSTOMISE_PANE_ID].set('p3');
    expect(hits).toBe(1);
    unsub();
    PANE_TARGET_STORES[CUSTOMISE_PANE_ID].set('p4');
    expect(hits).toBe(1);
  });
});
