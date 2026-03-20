import { describe, it, expect } from 'bun:test';
import { ClientEntrySchema, normalizeClientEntry } from '../../../src/models/workspace-config.js';

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
});
