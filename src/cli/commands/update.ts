import { Command } from 'commander';
import { execa } from 'execa';

/**
 * Detect package manager from a script path
 * Exported for testing
 */
export function detectPackageManagerFromPath(scriptPath: string): 'bun' | 'npm' {
  // Check for .bun in path (works on both Windows and Linux/macOS)
  if (scriptPath.includes('.bun')) {
    return 'bun';
  }
  return 'npm';
}

/**
 * Detect if allagents was installed via bun by checking the script path
 */
function detectPackageManager(): 'bun' | 'npm' {
  return detectPackageManagerFromPath(process.argv[1] ?? '');
}

/**
 * Get current installed version from package.json
 */
async function getCurrentVersion(): Promise<string> {
  // Import package.json to get version
  // Using dynamic import to handle ESM
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const pkg = require('../../../package.json');
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

export const updateCommand = new Command('update')
  .description('Update allagents to the latest version')
  .option('--npm', 'Force update using npm')
  .option('--bun', 'Force update using bun')
  .action(async (options: { npm?: boolean; bun?: boolean }) => {
    try {
      // Determine package manager to use
      let packageManager: 'bun' | 'npm';

      if (options.npm && options.bun) {
        console.error('Error: Cannot specify both --npm and --bun');
        process.exit(1);
      }

      if (options.npm) {
        packageManager = 'npm';
      } else if (options.bun) {
        packageManager = 'bun';
      } else {
        packageManager = detectPackageManager();
      }

      const currentVersion = await getCurrentVersion();
      console.log(`Current version: ${currentVersion}`);
      console.log(`Updating allagents using ${packageManager}...\n`);

      // Build the update command
      const args =
        packageManager === 'npm'
          ? ['install', '-g', 'allagents@latest']
          : ['add', '-g', 'allagents@latest'];

      // Execute the update
      const result = await execa(packageManager, args, {
        stdio: 'inherit',
      });

      if (result.exitCode === 0) {
        // Get the new version by spawning allagents --version
        try {
          const versionResult = await execa('allagents', ['--version']);
          const newVersion = versionResult.stdout.trim();
          console.log(`\nUpdate complete: ${currentVersion} → ${newVersion}`);
        } catch {
          // Fallback if we can't get new version
          console.log('\nUpdate complete.');
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        // Check if package manager is not available
        if (
          error.message.includes('ENOENT') ||
          error.message.includes('not found')
        ) {
          const detected = detectPackageManager();
          const alternative = detected === 'npm' ? 'bun' : 'npm';
          console.error(
            `Error: ${detected} not found. Try using --${alternative} flag.`,
          );
        } else {
          console.error(`Error: ${error.message}`);
        }
        process.exit(1);
      }
      throw error;
    }
  });
