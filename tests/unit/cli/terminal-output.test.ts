import { describe, expect, test } from 'bun:test';
import { terminalSafe } from '../../../src/cli/terminal-output.js';

describe('terminalSafe', () => {
  test('removes ANSI and terminal command sequences', () => {
    expect(
      terminalSafe(
        'source\u001b[31m-red\u001b[0m\u001b]2;forged title\u0007-end',
      ),
    ).toBe('source-red-end');
  });

  test('makes line breaks and direction overrides visible', () => {
    expect(terminalSafe('plugin\nforged\u202estatus')).toBe(
      'plugin�forged�status',
    );
  });

  test('accepts non-string error values', () => {
    expect(terminalSafe(42)).toBe('42');
  });
});
