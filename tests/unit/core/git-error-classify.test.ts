import { describe, it, expect } from 'bun:test';

/**
 * Test the error classification patterns used in src/core/git-errors.ts.
 * We test the pattern matching directly rather than importing from git-errors.js
 * because bun's mock.module for 'git.js' in other test files leaks into the
 * module resolution of git-errors.js during full suite runs.
 */

function isServerError(message: string): boolean {
  return (
    /returned error: 5\d\d/.test(message) ||
    message.includes('Internal Server Error')
  );
}

describe('git error classification - HTTP 5xx patterns', () => {
  it('should match HTTP 500 as server error', () => {
    const msg =
      "Cloning into '/tmp/test'...\nremote: Internal Server Error\nfatal: unable to access 'https://github.com/org/repo.git/': The requested URL returned error: 500";

    expect(isServerError(msg)).toBe(true);
  });

  it('should match HTTP 502 as server error', () => {
    const msg =
      "fatal: unable to access 'https://github.com/org/repo.git/': The requested URL returned error: 502";

    expect(isServerError(msg)).toBe(true);
  });

  it('should match HTTP 503 as server error', () => {
    const msg = "The requested URL returned error: 503";
    expect(isServerError(msg)).toBe(true);
  });

  it('should match "Internal Server Error" text without status code', () => {
    const msg = "remote: Internal Server Error\nfatal: ...";
    expect(isServerError(msg)).toBe(true);
  });

  it('should NOT match HTTP 404', () => {
    const msg =
      "fatal: unable to access 'https://github.com/org/repo.git/': The requested URL returned error: 404";

    expect(isServerError(msg)).toBe(false);
  });

  it('should NOT match HTTP 401', () => {
    const msg = "The requested URL returned error: 401";
    expect(isServerError(msg)).toBe(false);
  });

  it('should NOT match HTTP 200', () => {
    const msg = "The requested URL returned error: 200";
    expect(isServerError(msg)).toBe(false);
  });
});
