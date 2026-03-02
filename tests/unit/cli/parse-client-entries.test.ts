import { describe, it, expect } from 'bun:test';
import { parseClientEntries } from '../../../src/cli/commands/workspace.js';

describe('parseClientEntries', () => {
  it('parses plain client name as string', () => {
    expect(parseClientEntries('vscode')).toEqual(['vscode']);
  });

  it('parses client:mode as object entry', () => {
    expect(parseClientEntries('claude:native')).toEqual([
      { name: 'claude', install: 'native' },
    ]);
  });

  it('parses mixed entries', () => {
    expect(parseClientEntries('claude:native,copilot,vscode:file')).toEqual([
      { name: 'claude', install: 'native' },
      'copilot',
      { name: 'vscode', install: 'file' },
    ]);
  });

  it('throws on invalid client name', () => {
    expect(() => parseClientEntries('badclient')).toThrow('Invalid client(s): badclient');
  });

  it('throws on invalid install mode', () => {
    expect(() => parseClientEntries('claude:invalid')).toThrow(
      "Invalid install mode 'invalid' for client 'claude'",
    );
  });
});
