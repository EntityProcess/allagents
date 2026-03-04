import { describe, expect, test } from 'bun:test';
import { buildClientGroups } from '../../../../src/cli/tui/prompt-clients.js';

describe('buildClientGroups', () => {
  test('returns universal group with universal pre-selected and client-specific group with all others', () => {
    const { groups, initialValues } = buildClientGroups();

    // Universal group has exactly one option
    expect(groups['Universal (.agents/skills)']).toHaveLength(1);
    expect(groups['Universal (.agents/skills)']![0]!.value).toBe('universal');

    // Client-specific group has all other clients
    const clientSpecific = groups['Client-specific'];
    expect(clientSpecific!.length).toBeGreaterThan(10);
    expect(clientSpecific!.find((o) => o.value === 'universal')).toBeUndefined();
    expect(clientSpecific!.find((o) => o.value === 'claude')).toBeDefined();

    // Only universal is pre-selected
    expect(initialValues).toEqual(['universal']);
  });
});
