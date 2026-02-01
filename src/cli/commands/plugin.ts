import { command, subcommands, positional, option, string, optional } from 'cmd-ts';
import {
  addMarketplace,
  listMarketplaces,
  removeMarketplace,
  updateMarketplace,
  listMarketplacePlugins,
  getWellKnownMarketplaces,
} from '../../core/marketplace.js';
import { isJsonMode, jsonOutput } from '../json-output.js';

// =============================================================================
// plugin marketplace list
// =============================================================================

const marketplaceListCmd = command({
  name: 'list',
  description: 'List registered marketplaces',
  args: {},
  handler: async () => {
    try {
      const marketplaces = await listMarketplaces();

      if (isJsonMode()) {
        jsonOutput({
          success: true,
          command: 'plugin marketplace list',
          data: { marketplaces },
        });
        return;
      }

      if (marketplaces.length === 0) {
        console.log('No marketplaces registered.\n');
        console.log('Add a marketplace with:');
        console.log('  allagents plugin marketplace add <source>\n');
        console.log('Well-known marketplaces:');
        const wellKnown = getWellKnownMarketplaces();
        for (const [name, repo] of Object.entries(wellKnown)) {
          console.log(`  ${name} \u2192 ${repo}`);
        }
        return;
      }

      console.log('Registered marketplaces:\n');

      for (const mp of marketplaces) {
        const sourceInfo =
          mp.source.type === 'github'
            ? `GitHub: ${mp.source.location}`
            : `Local: ${mp.source.location}`;
        const updated = mp.lastUpdated
          ? new Date(mp.lastUpdated).toLocaleDateString()
          : 'never';

        console.log(`  ${mp.name}`);
        console.log(`    Source: ${sourceInfo}`);
        console.log(`    Path: ${mp.path}`);
        console.log(`    Last updated: ${updated}`);
        console.log();
      }

      console.log(`Total: ${marketplaces.length} marketplace(s)`);
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace list', error: error.message });
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
// plugin marketplace add
// =============================================================================

const marketplaceAddCmd = command({
  name: 'add',
  description: 'Add a marketplace from GitHub URL, owner/repo, local path, or well-known name',
  args: {
    source: positional({ type: string, displayName: 'source' }),
    name: option({ type: optional(string), long: 'name', short: 'n', description: 'Custom name for the marketplace' }),
  },
  handler: async ({ source, name }) => {
    try {
      if (!isJsonMode()) {
        console.log(`Adding marketplace: ${source}...`);
      }

      const result = await addMarketplace(source, name);

      if (!result.success) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace add', error: result.error ?? 'Unknown error' });
          process.exit(1);
        }
        console.error(`\nError: ${result.error}`);
        process.exit(1);
      }

      if (isJsonMode()) {
        jsonOutput({
          success: true,
          command: 'plugin marketplace add',
          data: {
            marketplace: {
              name: result.marketplace?.name,
              path: result.marketplace?.path,
            },
          },
        });
        return;
      }

      console.log(`\u2713 Marketplace '${result.marketplace?.name}' added`);
      console.log(`  Path: ${result.marketplace?.path}`);
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace add', error: error.message });
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
// plugin marketplace remove
// =============================================================================

const marketplaceRemoveCmd = command({
  name: 'remove',
  description: 'Remove a marketplace from registry (does not delete files)',
  args: {
    name: positional({ type: string, displayName: 'name' }),
  },
  handler: async ({ name }) => {
    try {
      const result = await removeMarketplace(name);

      if (!result.success) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace remove', error: result.error ?? 'Unknown error' });
          process.exit(1);
        }
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      if (isJsonMode()) {
        jsonOutput({
          success: true,
          command: 'plugin marketplace remove',
          data: {
            name,
            path: result.marketplace?.path,
          },
        });
        return;
      }

      console.log(`\u2713 Marketplace '${name}' removed from registry`);
      console.log(`  Note: Files at ${result.marketplace?.path} were not deleted`);
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace remove', error: error.message });
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
// plugin marketplace update
// =============================================================================

const marketplaceUpdateCmd = command({
  name: 'update',
  description: 'Update marketplace(s) from remote',
  args: {
    name: positional({ type: optional(string), displayName: 'name' }),
  },
  handler: async ({ name }) => {
    try {
      if (!isJsonMode()) {
        console.log(
          name
            ? `Updating marketplace: ${name}...`
            : 'Updating all marketplaces...',
        );
        console.log();
      }

      const results = await updateMarketplace(name);

      if (isJsonMode()) {
        const succeeded = results.filter((r) => r.success).length;
        const failed = results.filter((r) => !r.success).length;
        jsonOutput({
          success: failed === 0,
          command: 'plugin marketplace update',
          data: { results, succeeded, failed },
          ...(failed > 0 && { error: `${failed} marketplace(s) failed to update` }),
        });
        if (failed > 0) {
          process.exit(1);
        }
        return;
      }

      if (results.length === 0) {
        console.log('No marketplaces to update.');
        return;
      }

      let successCount = 0;
      let failCount = 0;

      for (const result of results) {
        if (result.success) {
          console.log(`\u2713 ${result.name}`);
          successCount++;
        } else {
          console.log(`\u2717 ${result.name}: ${result.error}`);
          failCount++;
        }
      }

      console.log();
      console.log(`Updated: ${successCount}, Failed: ${failCount}`);

      if (failCount > 0) {
        process.exit(1);
      }
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace update', error: error.message });
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
// plugin marketplace subcommands group
// =============================================================================

const marketplaceCmd = subcommands({
  name: 'marketplace',
  description: 'Manage plugin marketplaces',
  cmds: {
    list: marketplaceListCmd,
    add: marketplaceAddCmd,
    remove: marketplaceRemoveCmd,
    update: marketplaceUpdateCmd,
  },
});

// =============================================================================
// plugin list command - list plugins from marketplaces
// =============================================================================

const pluginListCmd = command({
  name: 'list',
  description: 'List available plugins from registered marketplaces',
  args: {
    marketplace: positional({ type: optional(string), displayName: 'marketplace' }),
  },
  handler: async ({ marketplace }) => {
    try {
      const marketplaces = await listMarketplaces();

      if (marketplaces.length === 0) {
        if (isJsonMode()) {
          jsonOutput({
            success: true,
            command: 'plugin list',
            data: { plugins: [], total: 0 },
          });
          return;
        }
        console.log('No marketplaces registered.\n');
        console.log('Add a marketplace first:');
        console.log('  allagents plugin marketplace add <source>');
        return;
      }

      // Filter to specific marketplace if provided
      const toList = marketplace
        ? marketplaces.filter((m) => m.name === marketplace)
        : marketplaces;

      if (marketplace && toList.length === 0) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin list', error: `Marketplace '${marketplace}' not found` });
          process.exit(1);
        }
        console.error(`Marketplace '${marketplace}' not found`);
        process.exit(1);
      }

      if (isJsonMode()) {
        const allPlugins: Array<{ name: string; marketplace: string }> = [];
        for (const mp of toList) {
          const plugins = await listMarketplacePlugins(mp.name);
          for (const plugin of plugins) {
            allPlugins.push({ name: plugin.name, marketplace: mp.name });
          }
        }
        jsonOutput({
          success: true,
          command: 'plugin list',
          data: { plugins: allPlugins, total: allPlugins.length },
        });
        return;
      }

      let totalPlugins = 0;

      for (const mp of toList) {
        const plugins = await listMarketplacePlugins(mp.name);

        if (plugins.length === 0) {
          console.log(`${mp.name}: (no plugins found)`);
          continue;
        }

        console.log(`${mp.name}:`);
        for (const plugin of plugins) {
          console.log(`  - ${plugin.name}@${mp.name}`);
          totalPlugins++;
        }
        console.log();
      }

      if (totalPlugins === 0) {
        console.log('No plugins found in registered marketplaces.');
      } else {
        console.log(`Total: ${totalPlugins} plugin(s)`);
      }
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin list', error: error.message });
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
// plugin validate command - validate a plugin structure
// =============================================================================

const pluginValidateCmd = command({
  name: 'validate',
  description: 'Validate plugin structure at the given path',
  args: {
    path: positional({ type: string, displayName: 'path' }),
  },
  handler: async ({ path }) => {
    if (isJsonMode()) {
      jsonOutput({
        success: true,
        command: 'plugin validate',
        data: { path, valid: false, message: 'not yet implemented' },
      });
      return;
    }
    // TODO: Implement plugin validation
    console.log(`Validating plugin at: ${path}`);
    console.log('(validation not yet implemented)');
  },
});

// =============================================================================
// plugin subcommands group
// =============================================================================

export const pluginCmd = subcommands({
  name: 'plugin',
  description: 'Manage plugins and marketplaces',
  cmds: {
    marketplace: marketplaceCmd,
    list: pluginListCmd,
    validate: pluginValidateCmd,
  },
});
