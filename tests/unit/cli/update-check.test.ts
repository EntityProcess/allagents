import { describe, it, expect } from 'bun:test';
import {
  getCachedUpdateInfo,
  shouldCheck,
  buildNotice,
} from '../../../src/cli/update-check.js';

describe('update-check', () => {
  describe('shouldCheck', () => {
    it('returns true when cache file does not exist', () => {
      expect(shouldCheck(null)).toBe(true);
    });

    it('returns true when lastCheckedAt is older than 24 hours', () => {
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      expect(shouldCheck({ latestVersion: '1.0.0', lastCheckedAt: old })).toBe(true);
    });

    it('returns false when lastCheckedAt is within 24 hours', () => {
      const recent = new Date().toISOString();
      expect(shouldCheck({ latestVersion: '1.0.0', lastCheckedAt: recent })).toBe(false);
    });
  });

  describe('buildNotice', () => {
    it('returns a notice string when latest > current', () => {
      const notice = buildNotice('0.13.4', '0.14.0');
      expect(notice).toContain('0.13.4');
      expect(notice).toContain('0.14.0');
      expect(notice).toContain('allagents self update');
    });

    it('returns null when versions are equal', () => {
      expect(buildNotice('0.13.4', '0.13.4')).toBeNull();
    });

    it('returns null when current > latest', () => {
      expect(buildNotice('0.14.0', '0.13.4')).toBeNull();
    });

    it('returns null when latest is null', () => {
      expect(buildNotice('0.13.4', null)).toBeNull();
    });
  });

  describe('getCachedUpdateInfo', () => {
    it('returns null for a nonexistent file', async () => {
      const result = await getCachedUpdateInfo('/tmp/does-not-exist.json');
      expect(result).toBeNull();
    });
  });
});
