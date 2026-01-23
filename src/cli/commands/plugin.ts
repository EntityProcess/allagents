import { Command } from 'commander';
import {
  addMarketplace,
  listMarketplaces,
  removeMarketplace,
  updateMarketplace,
  listMarketplacePlugins,
  getWellKnownMarketplaces,
} from '../../core/marketplace.js';

export const pluginCommand = new Command('plugin').description(
  'Manage plugins and marketplaces',
);

// =============================================================================
// plugin marketplace subcommand group
// =============================================================================

const marketplaceCommand = new Command('marketplace').description(
  'Manage plugin marketplaces',
);

marketplaceCommand
  .command('list')
  .description('List registered marketplaces')
  .action(async () => {
    try {
      const marketplaces = await listMarketplaces();

      if (marketplaces.length === 0) {
        console.log('No marketplaces registered.\n');
        console.log('Add a marketplace with:');
        console.log('  allagents plugin marketplace add <source>\n');
        console.log('Well-known marketplaces:');
        const wellKnown = getWellKnownMarketplaces();
        for (const [name, repo] of Object.entries(wellKnown)) {
          console.log(`  ${name} → ${repo}`);
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
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  });

marketplaceCommand
  .command('add <source>')
  .description('Add a marketplace from GitHub URL, owner/repo, local path, or well-known name')
  .option('-n, --name <name>', 'Custom name for the marketplace')
  .action(async (source: string, options: { name?: string }) => {
    try {
      console.log(`Adding marketplace: ${source}...`);

      const result = await addMarketplace(source, options.name);

      if (!result.success) {
        console.error(`\nError: ${result.error}`);
        process.exit(1);
      }

      console.log(`✓ Marketplace '${result.marketplace!.name}' added`);
      console.log(`  Path: ${result.marketplace!.path}`);
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  });

marketplaceCommand
  .command('remove <name>')
  .description('Remove a marketplace from registry (does not delete files)')
  .action(async (name: string) => {
    try {
      const result = await removeMarketplace(name);

      if (!result.success) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      console.log(`✓ Marketplace '${name}' removed from registry`);
      console.log(`  Note: Files at ${result.marketplace!.path} were not deleted`);
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  });

marketplaceCommand
  .command('update [name]')
  .description('Update marketplace(s) from remote')
  .action(async (name?: string) => {
    try {
      console.log(
        name
          ? `Updating marketplace: ${name}...`
          : 'Updating all marketplaces...',
      );
      console.log();

      const results = await updateMarketplace(name);

      if (results.length === 0) {
        console.log('No marketplaces to update.');
        return;
      }

      let successCount = 0;
      let failCount = 0;

      for (const result of results) {
        if (result.success) {
          console.log(`✓ ${result.name}`);
          successCount++;
        } else {
          console.log(`✗ ${result.name}: ${result.error}`);
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
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  });

pluginCommand.addCommand(marketplaceCommand);

// =============================================================================
// plugin list command - list plugins from marketplaces
// =============================================================================

pluginCommand
  .command('list [marketplace]')
  .description('List available plugins from registered marketplaces')
  .action(async (marketplace?: string) => {
    try {
      const marketplaces = await listMarketplaces();

      if (marketplaces.length === 0) {
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
        console.error(`Marketplace '${marketplace}' not found`);
        process.exit(1);
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
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  });

// =============================================================================
// plugin validate command - validate a plugin structure
// =============================================================================

pluginCommand
  .command('validate <path>')
  .description('Validate plugin structure at the given path')
  .action(async (path: string) => {
    // TODO: Implement plugin validation
    console.log(`Validating plugin at: ${path}`);
    console.log('(validation not yet implemented)');
  });
