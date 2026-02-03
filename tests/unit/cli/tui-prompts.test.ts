import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

// Mock @clack/prompts and sisteransi before importing the wrapper.
// These mocks are scoped to this file — placed under tests/unit/cli/
// to avoid leaking into src/cli/tui/__tests__/ where context.test.ts
// imports real modules.
const cancelSymbol = Symbol('clack:cancel');
const mockSelect = mock(() => Promise.resolve('value' as unknown));
const mockMultiselect = mock(() => Promise.resolve(['value'] as unknown));
const mockText = mock(() => Promise.resolve('text' as unknown));
const mockConfirm = mock(() => Promise.resolve(true as unknown));
const mockIsCancel = mock((v: unknown) => v === cancelSymbol);

mock.module('@clack/prompts', () => ({
  select: mockSelect,
  multiselect: mockMultiselect,
  text: mockText,
  confirm: mockConfirm,
  isCancel: mockIsCancel,
}));

const mockCursorMove = mock(() => '\x1b[MOVE]');
const mockEraseDown = mock(() => '\x1b[ERASE]');
mock.module('sisteransi', () => ({
  cursor: { move: mockCursorMove },
  erase: { down: mockEraseDown },
}));

let stdoutWrites: string[] = [];
const originalWrite = process.stdout.write;

const { select, multiselect, text, confirm } = await import(
  '../../../src/cli/tui/prompts.js'
);

describe('TUI prompt wrappers', () => {
  beforeEach(() => {
    stdoutWrites = [];
    process.stdout.write = ((data: string) => {
      stdoutWrites.push(data);
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
    mockSelect.mockReset();
    mockMultiselect.mockReset();
    mockText.mockReset();
    mockConfirm.mockReset();
    mockCursorMove.mockReset();
    mockEraseDown.mockReset();
  });

  describe('select', () => {
    it('returns value without erasing when not cancelled', async () => {
      mockSelect.mockResolvedValueOnce('chosen');
      const result = await select({ message: 'Pick', options: [] });
      expect(result).toBe('chosen');
      expect(stdoutWrites).toHaveLength(0);
    });

    it('erases prompt output when cancelled', async () => {
      mockSelect.mockResolvedValueOnce(cancelSymbol);
      const result = await select({ message: 'Pick', options: [] });
      expect(result).toBe(cancelSymbol);
      expect(mockCursorMove).toHaveBeenCalledWith(0, -2);
      expect(mockEraseDown).toHaveBeenCalled();
      expect(stdoutWrites.length).toBeGreaterThan(0);
    });
  });

  describe('multiselect', () => {
    it('returns value without erasing when not cancelled', async () => {
      mockMultiselect.mockResolvedValueOnce(['a', 'b']);
      const result = await multiselect({ message: 'Pick', options: [] });
      expect(result).toEqual(['a', 'b']);
      expect(stdoutWrites).toHaveLength(0);
    });

    it('erases prompt output when cancelled', async () => {
      mockMultiselect.mockResolvedValueOnce(cancelSymbol);
      const result = await multiselect({ message: 'Pick', options: [] });
      expect(result).toBe(cancelSymbol);
      expect(mockCursorMove).toHaveBeenCalledWith(0, -2);
      expect(mockEraseDown).toHaveBeenCalled();
    });
  });

  describe('text', () => {
    it('returns value without erasing when not cancelled', async () => {
      mockText.mockResolvedValueOnce('hello');
      const result = await text({ message: 'Type' });
      expect(result).toBe('hello');
      expect(stdoutWrites).toHaveLength(0);
    });

    it('erases prompt output when cancelled', async () => {
      mockText.mockResolvedValueOnce(cancelSymbol);
      const result = await text({ message: 'Type' });
      expect(result).toBe(cancelSymbol);
      expect(mockCursorMove).toHaveBeenCalledWith(0, -2);
      expect(mockEraseDown).toHaveBeenCalled();
    });
  });

  describe('confirm', () => {
    it('returns value without erasing when not cancelled', async () => {
      mockConfirm.mockResolvedValueOnce(true);
      const result = await confirm({ message: 'Sure?' });
      expect(result).toBe(true);
      expect(stdoutWrites).toHaveLength(0);
    });

    it('erases prompt output when cancelled', async () => {
      mockConfirm.mockResolvedValueOnce(cancelSymbol);
      const result = await confirm({ message: 'Sure?' });
      expect(result).toBe(cancelSymbol);
      expect(mockCursorMove).toHaveBeenCalledWith(0, -2);
      expect(mockEraseDown).toHaveBeenCalled();
    });
  });
});
