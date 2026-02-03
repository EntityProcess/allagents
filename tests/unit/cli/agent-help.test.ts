import { describe, test, expect } from 'bun:test';
import { extractAgentHelpFlag } from '../../../src/cli/agent-help.js';
import { initMeta, syncMeta, statusMeta } from '../../../src/cli/metadata/workspace.js';
import {
  marketplaceListMeta,
  marketplaceAddMeta,
  marketplaceRemoveMeta,
  marketplaceUpdateMeta,
  pluginListMeta,
  pluginValidateMeta,
  pluginInstallMeta,
  pluginUninstallMeta,
} from '../../../src/cli/metadata/plugin.js';
import { updateMeta } from '../../../src/cli/metadata/self.js';
import type { AgentCommandMeta } from '../../../src/cli/help.js';

const allCommands: AgentCommandMeta[] = [
  initMeta,
  syncMeta,
  statusMeta,
  pluginInstallMeta,
  pluginUninstallMeta,
  marketplaceListMeta,
  marketplaceAddMeta,
  marketplaceRemoveMeta,
  marketplaceUpdateMeta,
  pluginListMeta,
  pluginValidateMeta,
  updateMeta,
];

describe('extractAgentHelpFlag', () => {
  test('returns agentHelp false when flag is absent', () => {
    const result = extractAgentHelpFlag(['workspace', 'sync']);
    expect(result.agentHelp).toBe(false);
    expect(result.args).toEqual(['workspace', 'sync']);
  });

  test('strips --agent-help from end of args', () => {
    const result = extractAgentHelpFlag(['workspace', 'sync', '--agent-help']);
    expect(result.agentHelp).toBe(true);
    expect(result.args).toEqual(['workspace', 'sync']);
  });

  test('strips --agent-help from beginning of args', () => {
    const result = extractAgentHelpFlag(['--agent-help', 'workspace', 'sync']);
    expect(result.agentHelp).toBe(true);
    expect(result.args).toEqual(['workspace', 'sync']);
  });

  test('strips --agent-help from middle of args', () => {
    const result = extractAgentHelpFlag(['workspace', '--agent-help', 'sync']);
    expect(result.agentHelp).toBe(true);
    expect(result.args).toEqual(['workspace', 'sync']);
  });
});

describe('agent command metadata', () => {
  test('contains exactly 12 commands', () => {
    expect(allCommands.length).toBe(12);
  });

  test('all expected commands are present', () => {
    const names = allCommands.map((c) => c.command).sort();
    expect(names).toEqual([
      'plugin install',
      'plugin list',
      'plugin marketplace add',
      'plugin marketplace list',
      'plugin marketplace remove',
      'plugin marketplace update',
      'plugin uninstall',
      'plugin validate',
      'self update',
      'workspace init',
      'workspace status',
      'workspace sync',
    ]);
  });

  test('every command has required fields', () => {
    for (const cmd of allCommands) {
      expect(typeof cmd.command).toBe('string');
      expect(typeof cmd.description).toBe('string');
      expect(typeof cmd.whenToUse).toBe('string');
      expect(cmd.examples.length).toBeGreaterThan(0);
    }
  });

  test('workspace sync has expected options', () => {
    const syncCmd = allCommands.find((c) => c.command === 'workspace sync')!;
    expect(syncCmd.options).toBeInstanceOf(Array);
    expect(syncCmd.options!.length).toBe(3);

    const dryRun = syncCmd.options!.find((o) => o.flag === '--dry-run');
    expect(dryRun).toBeDefined();
    expect(dryRun!.type).toBe('boolean');
    expect(dryRun!.short).toBe('-n');

    const client = syncCmd.options!.find((o) => o.flag === '--client');
    expect(client).toBeDefined();
    expect(client!.type).toBe('string');
    expect(client!.short).toBe('-c');
  });

  test('plugin install has required positional', () => {
    const installCmd = allCommands.find((c) => c.command === 'plugin install')!;
    expect(installCmd.positionals).toBeInstanceOf(Array);
    expect(installCmd.positionals!.length).toBe(1);
    expect(installCmd.positionals![0].name).toBe('plugin');
    expect(installCmd.positionals![0].required).toBe(true);
  });

  test('workspace status has no positionals or options', () => {
    const statusCmd = allCommands.find((c) => c.command === 'workspace status')!;
    expect(statusCmd.positionals).toBeUndefined();
    expect(statusCmd.options).toBeUndefined();
  });
});
