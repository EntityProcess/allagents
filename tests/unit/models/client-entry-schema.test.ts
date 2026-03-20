import { describe, it, expect } from 'bun:test';
import { ClientEntrySchema, WorkspaceConfigSchema, normalizeClientEntry } from '../../../src/models/workspace-config.js';

describe('ClientEntrySchema', () => {
  describe('existing behavior', () => {
    it('parses bare client string', () => {
      expect(ClientEntrySchema.parse('claude')).toBe('claude');
    });

    it('parses object form with install mode', () => {
      expect(ClientEntrySchema.parse({ name: 'claude', install: 'native' })).toEqual({
        name: 'claude',
        install: 'native',
      });
    });

    it('defaults install to file in object form', () => {
      expect(ClientEntrySchema.parse({ name: 'claude' })).toEqual({
        name: 'claude',
        install: 'file',
      });
    });

    it('rejects invalid client name string', () => {
      expect(() => ClientEntrySchema.parse('fakeclient')).toThrow();
    });

    it('rejects invalid client name in object', () => {
      expect(() => ClientEntrySchema.parse({ name: 'fakeclient', install: 'file' })).toThrow();
    });
  });

  describe('normalizeClientEntry', () => {
    it('normalizes bare string to object', () => {
      expect(normalizeClientEntry('claude')).toEqual({ name: 'claude', install: 'file' });
    });

    it('normalizes object entry', () => {
      expect(normalizeClientEntry({ name: 'claude', install: 'native' })).toEqual({
        name: 'claude',
        install: 'native',
      });
    });
  });

  describe('colon shorthand', () => {
    it('parses claude:native to object', () => {
      expect(ClientEntrySchema.parse('claude:native')).toEqual({
        name: 'claude',
        install: 'native',
      });
    });

    it('parses claude:file to object', () => {
      expect(ClientEntrySchema.parse('claude:file')).toEqual({
        name: 'claude',
        install: 'file',
      });
    });

    it('rejects empty client name', () => {
      expect(() => ClientEntrySchema.parse(':native')).toThrow();
    });

    it('rejects empty install mode', () => {
      expect(() => ClientEntrySchema.parse('claude:')).toThrow();
    });

    it('rejects extra colons', () => {
      expect(() => ClientEntrySchema.parse('claude:native:extra')).toThrow();
    });

    it('rejects invalid install mode', () => {
      expect(() => ClientEntrySchema.parse('claude:bogus')).toThrow();
    });

    it('rejects invalid client with valid mode', () => {
      expect(() => ClientEntrySchema.parse('fakeclient:native')).toThrow();
    });

    it('rejects uppercase (case-sensitive)', () => {
      expect(() => ClientEntrySchema.parse('CLAUDE:NATIVE')).toThrow();
    });
  });

  describe('full WorkspaceConfigSchema with mixed client formats', () => {
    it('parses config with bare, shorthand, and object clients', () => {
      const config = WorkspaceConfigSchema.parse({
        repositories: [],
        plugins: [],
        clients: [
          'copilot',
          'claude:native',
          { name: 'cursor', install: 'file' },
        ],
      });
      expect(config.clients).toEqual([
        'copilot',
        { name: 'claude', install: 'native' },
        { name: 'cursor', install: 'file' },
      ]);
    });
  });
});
