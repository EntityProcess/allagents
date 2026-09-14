import { describe, expect, test } from 'bun:test';
import { PiNativeClient } from '../../../../src/core/native/pi.js';
import { OmpNativeClient } from '../../../../src/core/native/omp.js';
import { getNativeClient } from '../../../../src/core/native/registry.js';

describe('native registry', () => {
  test('registers Pi through the shared native client interface', () => {
    const client = getNativeClient('pi');

    expect(client).toBeInstanceOf(PiNativeClient);
    expect(client?.client).toBe('pi');
    expect(client?.supportsScope('user')).toBe(true);
    expect(client?.supportsScope('project')).toBe(true);
  });

  test('registers OMP through the shared native client interface', () => {
    const client = getNativeClient('omp');

    expect(client).toBeInstanceOf(OmpNativeClient);
    expect(client?.client).toBe('omp');
    expect(client?.supportsScope('user')).toBe(true);
    expect(client?.supportsScope('project')).toBe(true);
  });

  test('does not register clients without native lifecycle support', () => {
    expect(getNativeClient('cursor')).toBeNull();
  });
});
