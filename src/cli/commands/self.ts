import { command, flag } from 'cmd-ts';
import { execa } from 'execa';
import { isJsonMode, jsonOutput } from '../json-output.js';
import { buildDescription, conciseSubcommands } from '../help.js';
import { findPackageJson } from '../package-json.js';
import { updateMeta } from '../metadata/self.js';

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
function getCurrentVersion(): string {
  try {
    return findPackageJson(import.meta.url).version;
  } catch {
    return 'unknown';
  }
}

// =============================================================================
// self update
// =============================================================================

const updateCmd = command({
  name: 'update',
  description: buildDescription(updateMeta),
  args: {
    npm: flag({ long: 'npm', description: 'Force update using npm' }),
    bun: flag({ long: 'bun', description: 'Force update using bun' }),
  },
  handler: async ({ npm, bun }) => {
    try {
      // Determine package manager to use
      let packageManager: 'bun' | 'npm';

      if (npm && bun) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'self update', error: 'Cannot specify both --npm and --bun' });
          process.exit(1);
        }
        console.error('Error: Cannot specify both --npm and --bun');
        process.exit(1);
      }

      if (npm) {
        packageManager = 'npm';
      } else if (bun) {
        packageManager = 'bun';
      } else {
        packageManager = detectPackageManager();
      }

      const currentVersion = getCurrentVersion();

      if (!isJsonMode()) {
        console.log(`Current version: ${currentVersion}`);
        console.log(`Updating allagents using ${packageManager}...\n`);
      }

      // Build the update command
      const args =
        packageManager === 'npm'
          ? ['install', '-g', 'allagents@latest']
          : ['add', '-g', 'allagents@latest'];

      // In JSON mode, capture output instead of inheriting stdio
      const result = await execa(packageManager, args, {
        stdio: isJsonMode() ? 'pipe' : 'inherit',
      });

      if (result.exitCode === 0) {
        // Get the new version by spawning allagents --version
        let newVersion: string | undefined;
        try {
          const versionResult = await execa('allagents', ['--version']);
          newVersion = versionResult.stdout.trim();
        } catch {
          // Fallback if we can't get new version
        }

        if (isJsonMode()) {
          jsonOutput({
            success: true,
            command: 'self update',
            data: {
              previousVersion: currentVersion,
              newVersion: newVersion ?? 'unknown',
              packageManager,
            },
          });
          return;
        }

        if (newVersion) {
          console.log(`\nUpdate complete: ${currentVersion} \u2192 ${newVersion}`);
        } else {
          console.log('\nUpdate complete.');
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          // Check if package manager is not available
          if (
            error.message.includes('ENOENT') ||
            error.message.includes('not found')
          ) {
            const detected = detectPackageManager();
            const alternative = detected === 'npm' ? 'bun' : 'npm';
            jsonOutput({
              success: false,
              command: 'self update',
              error: `${detected} not found. Try using --${alternative} flag.`,
            });
          } else {
            jsonOutput({ success: false, command: 'self update', error: error.message });
          }
          process.exit(1);
        }
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
  },
});

// =============================================================================
// self subcommands group
// =============================================================================

export const selfCmd = conciseSubcommands({
  name: 'self',
  description: 'Manage the allagents installation',
  cmds: {
    update: updateCmd,
  },
});
