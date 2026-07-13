import { describe, expect, test, afterEach } from 'bun:test';
import { homedir } from 'node:os';
import { getHomeDir } from '../../src/constants.js';
import { stubHomeDir } from '../helpers/env.js';

describe('getHomeDir', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  test('uses and restores the explicit AllAgents test home override', () => {
    // Resolve os.homedir() first to reproduce Bun's process-level cache.
    const realHome = homedir();
    const restoreHomeDir = stubHomeDir('/tmp/allagents-isolated-home');

    try {
      expect(getHomeDir()).toBe('/tmp/allagents-isolated-home');
    } finally {
      restoreHomeDir();
    }

    expect(getHomeDir()).toBe(realHome);
  });

  // Windows-only: os.homedir() ignores HOME entirely on win32 (uses USERPROFILE),
  // so this needs HOME and USERPROFILE set to *different* values to prove the
  // point — stubHomeDir (which sets both to the same path) doesn't apply here.
  // On POSIX, os.homedir() reads $HOME directly, so a mistranslated HOME isn't
  // a platform-level failure mode there the way it is on Windows.
  test.skipIf(process.platform !== 'win32')(
    'ignores a HOME env var that has been mistranslated to a bare drive root',
    () => {
      // Reproduces the Git-Bash/MSYS failure mode: a misconfigured HOME=/c gets
      // translated to the literal Windows path "C:\\" for the spawned node process.
      // Trusting it would make every user-scope sync operation treat the whole
      // drive as "home" (see EntityProcess/allagents#433).
      process.env.HOME = 'C:\\';
      process.env.USERPROFILE = 'C:\\Users\\realuser';

      expect(getHomeDir()).toBe('C:\\Users\\realuser');
    },
  );
});
