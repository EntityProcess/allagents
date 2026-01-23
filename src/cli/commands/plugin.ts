import { Command } from 'commander';
import { fetchPlugin } from '../../core/plugin.js';

export const pluginCommand = new Command('plugin').description('Manage plugins');

pluginCommand
  .command('fetch <url>')
  .description('Fetch remote plugin to cache')
  .option('-f, --force', 'Force update if plugin is already cached')
  .action(async (url: string, options: { force?: boolean }) => {
    try {
      const result = await fetchPlugin(url, { force: options.force });

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
  .action(() => {
    console.log('TODO: List cached plugins');
  });

pluginCommand
  .command('update [name]')
  .description('Update cached plugin(s) from remote')
  .action((name?: string) => {
    console.log(`TODO: Update plugin ${name || 'all'}`);
  });
