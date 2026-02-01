import { describe, test, expect } from 'bun:test';
import { buildDescription, type CommandMeta } from '../../src/cli/help.js';
import { initMeta, syncMeta, statusMeta } from '../../src/cli/metadata/workspace.js';
import { marketplaceListMeta, marketplaceAddMeta, marketplaceRemoveMeta, marketplaceUpdateMeta, pluginListMeta, pluginValidateMeta, pluginInstallMeta, pluginUninstallMeta } from '../../src/cli/metadata/plugin.js';
import { updateMeta } from '../../src/cli/metadata/self.js';

/**
 * All command metadata objects that must have enriched help.
 */
const allCommandMetas: { name: string; meta: CommandMeta }[] = [
  { name: 'workspace init', meta: initMeta },
  { name: 'workspace sync', meta: syncMeta },
  { name: 'workspace status', meta: statusMeta },
  { name: 'plugin install', meta: pluginInstallMeta },
  { name: 'plugin uninstall', meta: pluginUninstallMeta },
  { name: 'plugin marketplace list', meta: marketplaceListMeta },
  { name: 'plugin marketplace add', meta: marketplaceAddMeta },
  { name: 'plugin marketplace remove', meta: marketplaceRemoveMeta },
  { name: 'plugin marketplace update', meta: marketplaceUpdateMeta },
  { name: 'plugin list', meta: pluginListMeta },
  { name: 'plugin validate', meta: pluginValidateMeta },
  { name: 'self update', meta: updateMeta },
];

describe('buildDescription', () => {
  test('produces a string containing all enriched sections', () => {
    const meta: CommandMeta = {
      description: 'Test command',
      whenToUse: 'When testing',
      examples: ['allagents test', 'allagents test --flag'],
      expectedOutput: 'Shows test output.',
    };
    const desc = buildDescription(meta);
    expect(desc).toContain('Test command');
    expect(desc).toContain('When to use: When testing');
    expect(desc).toContain('Examples:');
    expect(desc).toContain('$ allagents test');
    expect(desc).toContain('$ allagents test --flag');
    expect(desc).toContain('Output: Shows test output.');
  });
});

describe('enriched help metadata', () => {
  for (const { name, meta } of allCommandMetas) {
    describe(name, () => {
      test('has a non-empty description', () => {
        expect(meta.description.length).toBeGreaterThan(0);
      });

      test('has a non-empty whenToUse', () => {
        expect(meta.whenToUse.length).toBeGreaterThan(0);
      });

      test('has at least one example', () => {
        expect(meta.examples.length).toBeGreaterThanOrEqual(1);
      });

      test('has a non-empty expectedOutput', () => {
        expect(meta.expectedOutput.length).toBeGreaterThan(0);
      });

      test('buildDescription output includes "When to use:" section', () => {
        const desc = buildDescription(meta);
        expect(desc).toContain('When to use:');
      });

      test('buildDescription output includes "Examples:" section with at least one $ example', () => {
        const desc = buildDescription(meta);
        expect(desc).toContain('Examples:');
        expect(desc).toMatch(/\$ /);
      });

      test('buildDescription output includes "Output:" section', () => {
        const desc = buildDescription(meta);
        expect(desc).toContain('Output:');
      });
    });
  }
});
