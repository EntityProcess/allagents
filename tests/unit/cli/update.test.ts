import { describe, it, expect } from 'bun:test';
import { detectPackageManagerFromPath } from '../../../src/cli/commands/self.js';

describe('update command', () => {
  describe('detectPackageManagerFromPath', () => {
    it('should detect bun from Linux/macOS global install path', () => {
      const path = '/home/user/.bun/install/global/node_modules/.bin/allagents';
      expect(detectPackageManagerFromPath(path)).toBe('bun');
    });

    it('should detect bun from Windows global install path', () => {
      const path =
        'C:\\Users\\user\\.bun\\install\\global\\node_modules\\.bin\\allagents';
      expect(detectPackageManagerFromPath(path)).toBe('bun');
    });

    it('should detect npm from Linux/macOS global install path', () => {
      const path = '/usr/local/lib/node_modules/allagents/dist/index.js';
      expect(detectPackageManagerFromPath(path)).toBe('npm');
    });

    it('should detect npm from Windows global install path', () => {
      const path =
        'C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\allagents\\dist\\index.js';
      expect(detectPackageManagerFromPath(path)).toBe('npm');
    });

    it('should detect npm from custom npm prefix path', () => {
      const path = '/home/user/.npm-global/lib/node_modules/allagents/dist/index.js';
      expect(detectPackageManagerFromPath(path)).toBe('npm');
    });

    it('should default to npm for unknown paths', () => {
      const path = '/some/random/path/allagents';
      expect(detectPackageManagerFromPath(path)).toBe('npm');
    });

    it('should default to npm for empty path', () => {
      expect(detectPackageManagerFromPath('')).toBe('npm');
    });
  });
});
