import { describe, expect, test } from 'bun:test';
import { getBrowserOpenCommands } from '../../../src/core/mcp-http-stdio-proxy.js';

describe('getBrowserOpenCommands', () => {
  test('uses explorer on Windows so OAuth URLs are not parsed by cmd', () => {
    const url =
      'https://idp.example/auth?response_type=code&client_id=test&state=abc';

    expect(getBrowserOpenCommands(url, 'win32')).toEqual([
      { command: 'explorer.exe', args: [url] },
    ]);
  });
});