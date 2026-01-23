import { Command } from 'commander';
import {
  fetchPlugin,
  listCachedPlugins,
  updateCachedPlugins,
} from '../../core/plugin.js';

export const pluginCommand = new Command('plugin').description(
  'Manage remote plugins - fetch, list, and update from GitHub',
);

pluginCommand
  .command('fetch <url>')
  .description('Fetch remote plugin to cache')
  .option('-f, --force', 'Force update if plugin is already cached')
  .action(async (url: string, options: { force?: boolean }) => {
    try {
      const result = await fetchPlugin(url, { force: options.force ?? false });

      if (!result.success) {
        console.error(`Error: ${result.error}`);
        process.exit(result.error?.includes('not installed') ? 2 : 3);
      }

      // Handle different actions
      switch (result.action) {
        case 'fetched':
          console.log(`Fetching plugin from ${url}...`);
          console.log(`✓ Plugin cached at: ${result.cachePath}`);
          break;

        case 'updated':
          console.log(`Updating cached plugin from ${url}...`);
          console.log(`✓ Plugin updated at: ${result.cachePath}`);
          break;

        case 'skipped':
          console.log(`Plugin already cached at: ${result.cachePath}`);
          console.log('Use --force to update');
          break;
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  });

pluginCommand
  .command('list')
  .description('List cached plugins')
  .action(async () => {
    try {
      const plugins = await listCachedPlugins();

      if (plugins.length === 0) {
        console.log('No cached plugins found.');
        console.log('\nFetch a plugin with:');
        console.log('  allagents plugin fetch <github-url>');
        return;
      }

      console.log('Cached plugins:\n');

      for (const plugin of plugins) {
        const date = plugin.lastModified.toLocaleDateString();
        console.log(`  ${plugin.name}`);
        console.log(`    Path: ${plugin.path}`);
        console.log(`    Last modified: ${date}`);
        console.log();
      }

      console.log(`Total: ${plugins.length} plugin(s)`);
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  });

pluginCommand
  .command('update [name]')
  .description('Update cached plugin(s) from remote')
  .action(async (name?: string) => {
    try {
      console.log(
        name ? `Updating plugin: ${name}...` : 'Updating all cached plugins...',
      );
      console.log();

      const results = await updateCachedPlugins(name);

      if (results.length === 0) {
        console.log('No cached plugins to update.');
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
