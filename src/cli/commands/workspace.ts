import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { command, positional, option, flag, string, optional } from 'cmd-ts';
import { initWorkspace } from '../../core/workspace.js';
import { syncWorkspace, syncUserWorkspace, mergeSyncResults, validatePlugin } from '../../core/sync.js';
import type { SyncResult } from '../../core/sync.js';
import { getPluginName } from '../../core/plugin.js';
import { getWorkspaceStatus } from '../../core/status.js';
import { pruneOrphanedPlugins } from '../../core/prune.js';
import { getUserWorkspaceConfig, ensureUserWorkspace } from '../../core/user-workspace.js';
import { addRepository, removeRepository, listRepositories, detectRemote, updateAgentFiles } from '../../core/workspace-repo.js';
import {
  generateVscodeWorkspace,
  getWorkspaceOutputPath,
  scanPluginForCopilotDirs,
  type ResolvedPluginInfo,
} from '../../core/vscode-workspace.js';
import { parseWorkspaceConfig } from '../../utils/workspace-parser.js';
import { isJsonMode, jsonOutput } from '../json-output.js';
import { buildDescription, conciseSubcommands } from '../help.js';
import { initMeta, syncMeta, statusMeta, pruneMeta } from '../metadata/workspace.js';
import { repoAddMeta, repoRemoveMeta, repoListMeta } from '../metadata/workspace-repo.js';
import { setupMeta } from '../metadata/workspace-setup.js';

/**
 * Build a JSON-friendly sync data object from a sync result.
 */
function buildSyncData(result: SyncResult) {
  return {
    copied: result.totalCopied,
    generated: result.totalGenerated,
    failed: result.totalFailed,
    skipped: result.totalSkipped,
    plugins: result.pluginResults.map((pr) => ({
      plugin: pr.plugin,
      success: pr.success,
      error: pr.error,
      copied: pr.copyResults.filter((r) => r.action === 'copied').length,
      generated: pr.copyResults.filter((r) => r.action === 'generated').length,
      failed: pr.copyResults.filter((r) => r.action === 'failed').length,
      copyResults: pr.copyResults,
    })),
    purgedPaths: result.purgedPaths ?? [],
  };
}

// =============================================================================
// workspace init
// =============================================================================

const initCmd = command({
  name: 'init',
  description: buildDescription(initMeta),
  args: {
    path: positional({ type: optional(string), displayName: 'path' }),
    from: option({ type: optional(string), long: 'from', description: 'Copy workspace.yaml from existing template/workspace' }),
  },
  handler: async ({ path, from }) => {
    try {
      const targetPath = path ?? '.';
      const result = await initWorkspace(targetPath, from ? { from } : {});

      if (isJsonMode()) {
        const syncData = result.syncResult ? buildSyncData(result.syncResult) : null;
        jsonOutput({
          success: true,
          command: 'workspace init',
          data: { path: targetPath, syncResult: syncData },
        });
        return;
      }

      // Print sync results if sync was performed
      if (result.syncResult) {
        const syncResult = result.syncResult;

        if (syncResult.pluginResults.length > 0) {
          console.log('\nPlugin sync results:');
          for (const pluginResult of syncResult.pluginResults) {
            const status = pluginResult.success ? '\u2713' : '\u2717';
            console.log(`  ${status} ${pluginResult.plugin}`);
            if (pluginResult.error) {
              console.log(`    Error: ${pluginResult.error}`);
            }
          }
        }

        console.log(`\nSync complete: ${syncResult.totalCopied} files copied`);
        if (syncResult.totalFailed > 0) {
          console.log(`  Failed: ${syncResult.totalFailed}`);
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'workspace init', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// workspace sync
// =============================================================================

const syncCmd = command({
  name: 'sync',
  description: buildDescription(syncMeta),
  args: {
    offline: flag({ long: 'offline', description: 'Use cached plugins without fetching latest from remote' }),
    dryRun: flag({ long: 'dry-run', short: 'n', description: 'Simulate sync without making changes' }),
    client: option({ type: optional(string), long: 'client', short: 'c', description: 'Sync only the specified client (e.g., opencode, claude)' }),
  },
  handler: async ({ offline, dryRun, client }) => {
    try {
      if (!isJsonMode() && dryRun) {
        console.log('Dry run mode - no changes will be made\n');
      }
      if (!isJsonMode() && client) {
        console.log(`Syncing client: ${client}\n`);
      }

      const userConfigExists = !!(await getUserWorkspaceConfig());
      const projectConfigPath = join(process.cwd(), '.allagents', 'workspace.yaml');
      const projectConfigExists = existsSync(projectConfigPath);

      // If neither config exists, auto-create user config and show guidance
      if (!userConfigExists && !projectConfigExists) {
        await ensureUserWorkspace();
        if (isJsonMode()) {
          jsonOutput({ success: true, command: 'workspace sync', data: { message: 'No plugins configured' } });
        } else {
          console.log('No plugins configured. Run `allagents plugin install <plugin>` to get started.');
        }
        return;
      }

      let combined: SyncResult | null = null;

      // Sync user workspace if config exists
      if (userConfigExists) {
        if (!isJsonMode()) {
          console.log('Syncing user workspace...\n');
        }
        const userResult = await syncUserWorkspace({ offline, dryRun });
        combined = userResult;
      }

      // Sync project workspace if config exists
      if (projectConfigExists) {
        if (!isJsonMode()) {
          console.log('Syncing project workspace...\n');
        }
        const projectResult = await syncWorkspace(process.cwd(), {
          offline,
          dryRun,
          ...(client && { clients: [client] }),
        });
        combined = combined ? mergeSyncResults(combined, projectResult) : projectResult;
      }

      // At this point, at least one config existed so combined is set
      const result = combined as SyncResult;

      if (isJsonMode()) {
        const syncData = buildSyncData(result);
        const success = result.success && result.totalFailed === 0;
        jsonOutput({
          success,
          command: 'workspace sync',
          data: syncData,
          ...(!success && { error: 'Sync completed with failures' }),
        });
        if (!success) {
          process.exit(1);
        }
        return;
      }

      // Show purge plan in dry-run mode
      if (dryRun && result.purgedPaths && result.purgedPaths.length > 0) {
        console.log('Would purge managed directories:');
        for (const purgePath of result.purgedPaths) {
          console.log(`  ${purgePath.client}:`);
          for (const path of purgePath.paths) {
            console.log(`    - ${path}`);
          }
        }
        console.log('');
      }

      // Print plugin results
      for (const pluginResult of result.pluginResults) {
        const status = pluginResult.success ? '\u2713' : '\u2717';
        console.log(`${status} Plugin: ${pluginResult.plugin}`);

        if (pluginResult.error) {
          console.log(`  Error: ${pluginResult.error}`);
        }

        const copied = pluginResult.copyResults.filter((r) => r.action === 'copied').length;
        const generated = pluginResult.copyResults.filter((r) => r.action === 'generated').length;
        const failed = pluginResult.copyResults.filter((r) => r.action === 'failed').length;

        if (copied > 0) console.log(`  Copied: ${copied} files`);
        if (generated > 0) console.log(`  Generated: ${generated} files`);
        if (failed > 0) {
          console.log(`  Failed: ${failed} files`);
          for (const failedResult of pluginResult.copyResults.filter((r) => r.action === 'failed')) {
            console.log(`    - ${failedResult.destination}: ${failedResult.error}`);
          }
        }
      }

      // Show warnings
      if (result.warnings && result.warnings.length > 0) {
        console.log('\nWarnings:');
        for (const warning of result.warnings) {
          console.log(`  \u26A0 ${warning}`);
        }
      }

      // Print summary
      console.log(`\nSync complete${dryRun ? ' (dry run)' : ''}:`);
      console.log(`  Total ${dryRun ? 'would copy' : 'copied'}: ${result.totalCopied}`);
      if (result.totalGenerated > 0) console.log(`  Total generated: ${result.totalGenerated}`);
      if (result.totalFailed > 0) console.log(`  Total failed: ${result.totalFailed}`);
      if (result.totalSkipped > 0) console.log(`  Total skipped: ${result.totalSkipped}`);

      if (!result.success || result.totalFailed > 0) {
        process.exit(1);
      }
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'workspace sync', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// workspace status
// =============================================================================

const statusCmd = command({
  name: 'status',
  description: buildDescription(statusMeta),
  args: {},
  handler: async () => {
    try {
      const result = await getWorkspaceStatus();

      if (!result.success) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'workspace status', error: result.error ?? 'Unknown error' });
          process.exit(1);
        }
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      if (isJsonMode()) {
        jsonOutput({
          success: true,
          command: 'workspace status',
          data: { plugins: result.plugins, userPlugins: result.userPlugins ?? [], clients: result.clients },
        });
        return;
      }

      // Display project plugins
      console.log(`Project Plugins (${result.plugins.length}):`);
      if (result.plugins.length === 0) {
        console.log('  No plugins configured');
      } else {
        for (const plugin of result.plugins) {
          const status = plugin.available ? '\u2713' : '\u2717';
          let typeLabel: string | undefined;
          if (plugin.type === 'marketplace') {
            typeLabel = plugin.available ? undefined : 'not synced';
          } else if (plugin.type === 'github') {
            typeLabel = plugin.available ? 'cached' : 'not cached';
          } else {
            typeLabel = 'local';
          }
          const suffix = typeLabel ? ` (${typeLabel})` : '';
          console.log(`  ${status} ${plugin.source}${suffix}`);
        }
      }

      // Display user plugins
      if (result.userPlugins) {
        console.log(`\nUser Plugins (${result.userPlugins.length}):`);
        if (result.userPlugins.length === 0) {
          console.log('  No user plugins configured');
        } else {
          for (const plugin of result.userPlugins) {
            const status = plugin.available ? '\u2713' : '\u2717';
            let typeLabel: string | undefined;
            if (plugin.type === 'marketplace') {
              typeLabel = plugin.available ? undefined : 'not synced';
            } else if (plugin.type === 'github') {
              typeLabel = plugin.available ? 'cached' : 'not cached';
            } else {
              typeLabel = 'local';
            }
            const suffix = typeLabel ? ` (${typeLabel})` : '';
            console.log(`  ${status} ${plugin.source}${suffix}`);
          }
        }
      }

      // Display clients
      console.log(`\nClients (${result.clients.length}):`);
      if (result.clients.length === 0) {
        console.log('  No clients configured');
      } else {
        console.log(`  ${result.clients.join(', ')}`);
      }
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'workspace status', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// workspace prune
// =============================================================================

const pruneCmd = command({
  name: 'prune',
  description: buildDescription(pruneMeta),
  args: {},
  handler: async () => {
    try {
      const result = await pruneOrphanedPlugins(process.cwd());

      if (isJsonMode()) {
        jsonOutput({
          success: true,
          command: 'workspace prune',
          data: result,
        });
        return;
      }

      const totalRemoved = result.project.removed.length + result.user.removed.length;

      if (totalRemoved === 0) {
        console.log('No orphaned plugins found.');
        return;
      }

      if (result.project.removed.length > 0) {
        console.log(`Project plugins pruned (${result.project.removed.length}):`);
        for (const p of result.project.removed) {
          console.log(`  - ${p}`);
        }
      }

      if (result.user.removed.length > 0) {
        console.log(`User plugins pruned (${result.user.removed.length}):`);
        for (const p of result.user.removed) {
          console.log(`  - ${p}`);
        }
      }

      console.log(`\n\u2713 Removed ${totalRemoved} orphaned plugin(s)`);
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'workspace prune', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// workspace repo add
// =============================================================================

const repoAddCmd = command({
  name: 'add',
  description: buildDescription(repoAddMeta),
  args: {
    path: positional({ type: string, displayName: 'path' }),
    description: option({ type: optional(string), long: 'description', short: 'd', description: 'Repository description' }),
  },
  handler: async ({ path: repoPath, description }) => {
    try {
      // Auto-detect source and repo from git remote
      const resolvedPath = resolve(process.cwd(), repoPath);
      const remote = await detectRemote(resolvedPath);

      const result = await addRepository(repoPath, {
        source: remote?.source,
        repo: remote?.repo,
        description,
      });

      if (!result.success) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'workspace repo add', error: result.error ?? 'Unknown error' });
          process.exit(1);
        }
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      // Ensure WORKSPACE-RULES are injected into agent files
      await updateAgentFiles();

      if (isJsonMode()) {
        jsonOutput({
          success: true,
          command: 'workspace repo add',
          data: {
            path: repoPath,
            source: remote?.source ?? null,
            repo: remote?.repo ?? null,
            description: description ?? null,
          },
        });
        return;
      }

      console.log(`\u2713 Added repository: ${repoPath}`);
      if (remote) console.log(`  Source: ${remote.source} (${remote.repo})`);
      if (description) console.log(`  Description: ${description}`);
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'workspace repo add', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// workspace repo remove
// =============================================================================

const repoRemoveCmd = command({
  name: 'remove',
  description: buildDescription(repoRemoveMeta),
  args: {
    path: positional({ type: string, displayName: 'path' }),
  },
  handler: async ({ path: repoPath }) => {
    try {
      const result = await removeRepository(repoPath);

      if (!result.success) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'workspace repo remove', error: result.error ?? 'Unknown error' });
          process.exit(1);
        }
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      // Ensure WORKSPACE-RULES are injected into agent files
      await updateAgentFiles();

      if (isJsonMode()) {
        jsonOutput({ success: true, command: 'workspace repo remove', data: { path: repoPath } });
        return;
      }

      console.log(`\u2713 Removed repository: ${repoPath}`);
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'workspace repo remove', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// workspace repo list
// =============================================================================

const repoListCmd = command({
  name: 'list',
  description: buildDescription(repoListMeta),
  args: {},
  handler: async () => {
    try {
      const repos = await listRepositories();

      if (isJsonMode()) {
        jsonOutput({
          success: true,
          command: 'workspace repo list',
          data: { repositories: repos, total: repos.length },
        });
        return;
      }

      if (repos.length === 0) {
        console.log('No repositories configured.\n');
        console.log('Add a repository with:');
        console.log('  allagents workspace repo add <path>');
        return;
      }

      console.log('Repositories:\n');
      for (const repo of repos) {
        console.log(`  ${repo.path}`);
        if (repo.source && repo.repo) console.log(`    Source: ${repo.source} (${repo.repo})`);
        if (repo.description) console.log(`    Description: ${repo.description}`);
        console.log();
      }
      console.log(`Total: ${repos.length} repository(ies)`);
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'workspace repo list', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// workspace repo subcommands group
// =============================================================================

const repoCmd = conciseSubcommands({
  name: 'repo',
  description: 'Manage workspace repositories',
  cmds: {
    add: repoAddCmd,
    remove: repoRemoveCmd,
    list: repoListCmd,
  },
});

// =============================================================================
// workspace setup
// =============================================================================

const VSCODE_TEMPLATE_FILE = 'vscode-template.json';

const setupCmd = command({
  name: 'setup',
  description: buildDescription(setupMeta),
  args: {
    output: option({
      type: optional(string),
      long: 'output',
      short: 'o',
      description: 'Output filename (default: <dirname>.code-workspace)',
    }),
  },
  handler: async ({ output }) => {
    try {
      const workspacePath = process.cwd();
      const configDir = join(workspacePath, '.allagents');
      const configPath = join(configDir, 'workspace.yaml');

      if (!existsSync(configPath)) {
        const msg = '.allagents/workspace.yaml not found. Run `allagents workspace init` first.';
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'workspace setup', error: msg });
          process.exit(1);
        }
        console.error(`Error: ${msg}`);
        process.exit(1);
      }

      const config = await parseWorkspaceConfig(configPath);

      // Load template if it exists
      const templatePath = join(configDir, VSCODE_TEMPLATE_FILE);
      let template: Record<string, unknown> | undefined;
      if (existsSync(templatePath)) {
        template = JSON.parse(readFileSync(templatePath, 'utf-8'));
      }

      // Resolve plugin paths (use cached/offline)
      const plugins: ResolvedPluginInfo[] = [];
      for (const pluginSource of config.plugins) {
        const validated = await validatePlugin(pluginSource, workspacePath, true);
        if (validated.success) {
          const dirs = scanPluginForCopilotDirs(validated.resolved);
          const pluginName = validated.pluginName ?? await getPluginName(validated.resolved);
          plugins.push({
            resolvedPath: validated.resolved,
            displayName: pluginName,
            hasPrompts: dirs.hasPrompts,
            hasInstructions: dirs.hasInstructions,
          });
        }
      }

      const content = generateVscodeWorkspace({
        workspacePath,
        repositories: config.repositories,
        plugins,
        template,
      });

      const outputPath = getWorkspaceOutputPath(workspacePath, config.vscode, output);

      const { writeFileSync: writeFile } = await import('node:fs');
      writeFile(outputPath, JSON.stringify(content, null, '\t') + '\n', 'utf-8');

      if (isJsonMode()) {
        jsonOutput({
          success: true,
          command: 'workspace setup',
          data: {
            path: outputPath,
            folders: (content.folders as unknown[]).length,
            hasTemplate: !!template,
          },
        });
        return;
      }

      console.log(`\u2713 Generated: ${outputPath}`);
      console.log(`  Folders: ${(content.folders as unknown[]).length}`);
      if (template) {
        console.log(`  Template: ${VSCODE_TEMPLATE_FILE}`);
      }
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'workspace setup', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// workspace subcommands group
// =============================================================================

export const workspaceCmd = conciseSubcommands({
  name: 'workspace',
  description: 'Manage AI agent workspaces - initialize, sync, and configure plugins',
  cmds: {
    init: initCmd,
    sync: syncCmd,
    status: statusCmd,
    prune: pruneCmd,
    repo: repoCmd,
    setup: setupCmd,
  },
});
