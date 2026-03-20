import { describe, expect, test } from 'bun:test';
import { buildClientOptions } from '../../../../src/cli/tui/prompt-clients.js';

describe('buildClientOptions', () => {
  test('returns flat options list with all clients including universal', () => {
    const options = buildClientOptions();

    // Should have all clients
    expect(options.length).toBeGreaterThan(10);

    // Universal should be present
    expect(options.find((o) => o.value === 'universal')).toBeDefined();

    // Claude should be present
    expect(options.find((o) => o.value === 'claude')).toBeDefined();

    // Each option should have a hint (skills path)
    for (const option of options) {
      expect(option.hint).toBeDefined();
    }
  });
});
