import * as p from '@clack/prompts';
import { execa } from 'execa';

/**
 * Self-update action.
 * Detects the package manager and runs a global update for allagents.
 */
export async function runUpdate(): Promise<void> {
  try {
    const confirmed = await p.confirm({
      message: 'Check for and install updates?',
    });

    if (p.isCancel(confirmed) || !confirmed) {
      return;
    }

    // Detect package manager from process.argv
    const isBun = process.argv[1]?.includes('.bun');
    const pm = isBun ? 'bun' : 'npm';

    const s = p.spinner();
    s.start(`Updating via ${pm}...`);

    const args = isBun
      ? ['add', '-g', 'allagents@latest']
      : ['install', '-g', 'allagents@latest'];

    await execa(pm, args);

    s.stop('Update complete');
    p.note(`Updated allagents via ${pm}`, 'Success');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.note(message, 'Error');
  }
}
