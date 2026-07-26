import {describe, it, expect} from 'vitest';
import {
  AGENT_EDITS_MODES,
  AGENT_EDITS_POLICIES,
  resolveAgentEdits,
  type AgentEditsMode,
  type AgentEditsPolicy,
} from './types';
import {DEFAULT_INSTANCE_CONFIG} from './provenance';

describe('agent-edits contract (AGED-1)', () => {
  it('exposes the two instance modes and three page policies', () => {
    expect(AGENT_EDITS_MODES).toEqual(['suggest', 'direct']);
    expect(AGENT_EDITS_POLICIES).toEqual(['inherit', 'suggest', 'direct']);
  });

  it('defaults the instance to suggest (no unattended direct edits)', () => {
    expect(DEFAULT_INSTANCE_CONFIG.agentEdits).toBe('suggest');
  });

  describe('resolveAgentEdits — the full 6-cell matrix (page × instance)', () => {
    const cases: Array<[AgentEditsPolicy, AgentEditsMode, AgentEditsMode]> = [
      // page = inherit ⇒ take the instance mode
      ['inherit', 'suggest', 'suggest'],
      ['inherit', 'direct', 'direct'],
      // page = suggest ⇒ page wins regardless of instance
      ['suggest', 'suggest', 'suggest'],
      ['suggest', 'direct', 'suggest'],
      // page = direct ⇒ page wins regardless of instance
      ['direct', 'suggest', 'direct'],
      ['direct', 'direct', 'direct'],
    ];
    it.each(cases)('page=%s instance=%s ⇒ %s', (page, instance, expected) => {
      expect(resolveAgentEdits(page, instance)).toBe(expected);
    });
  });

  it('falls back to suggest when the instance mode is undefined (pre-AGED-1 / unset)', () => {
    expect(resolveAgentEdits('inherit', undefined)).toBe('suggest');
    // an explicit page policy still wins over an absent instance mode
    expect(resolveAgentEdits('direct', undefined)).toBe('direct');
    expect(resolveAgentEdits('suggest', undefined)).toBe('suggest');
  });
});
