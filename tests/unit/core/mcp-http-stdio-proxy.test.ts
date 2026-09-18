import { describe, expect, test } from 'bun:test';
import {
  getBrowserOpenCommands,
  parseOAuthCallbackUrl,
  validateOAuthCallbackUrl,
} from '../../../src/core/mcp-http-stdio-proxy.js';

describe('getBrowserOpenCommands', () => {
  test('uses explorer on Windows so OAuth URLs are not parsed by cmd', () => {
    const url =
      'https://idp.example/auth?response_type=code&client_id=test&state=abc';

    expect(getBrowserOpenCommands(url, 'win32')).toEqual([
      { command: 'explorer.exe', args: [url] },
    ]);
  });
});

describe('parseOAuthCallbackUrl', () => {
  const redirectUrl = 'http://127.0.0.1:38421/callback';
  const state = 'expected-state';

  test('returns the code from the registered callback URL', () => {
    expect(
      parseOAuthCallbackUrl(
        `${redirectUrl}?code=authorization-code&state=${state}`,
        redirectUrl,
        state,
      ),
    ).toBe('authorization-code');
  });

  test.each([
    [
      'different state',
      `${redirectUrl}?code=authorization-code&state=wrong-state`,
      'OAuth state validation failed',
    ],
    [
      'duplicate state',
      `${redirectUrl}?code=authorization-code&state=${state}&state=${state}`,
      'OAuth state validation failed',
    ],
    [
      'missing state',
      `${redirectUrl}?code=authorization-code`,
      'OAuth state validation failed',
    ],
    [
      'different loopback port',
      `http://127.0.0.1:9999/callback?code=authorization-code&state=${state}`,
      'OAuth callback URL does not match',
    ],
    [
      'different callback path',
      `http://127.0.0.1:38421/other?code=authorization-code&state=${state}`,
      'OAuth callback URL does not match',
    ],
    [
      'embedded credentials',
      `http://user@127.0.0.1:38421/callback?code=authorization-code&state=${state}`,
      'OAuth callback URL does not match',
    ],
    [
      'fragment',
      `${redirectUrl}?code=authorization-code&state=${state}#fragment`,
      'OAuth callback URL does not match',
    ],
    [
      'missing code',
      `${redirectUrl}?state=${state}`,
      'No OAuth authorization code received',
    ],
    [
      'empty code',
      `${redirectUrl}?code=&state=${state}`,
      'No OAuth authorization code received',
    ],
    [
      'duplicate code',
      `${redirectUrl}?code=one&code=two&state=${state}`,
      'No OAuth authorization code received',
    ],
    [
      'code and error',
      `${redirectUrl}?code=one&error=access_denied&state=${state}`,
      'Invalid OAuth authorization response',
    ],
  ])('rejects a callback with %s', (_name, callbackUrl, message) => {
    expect(() =>
      parseOAuthCallbackUrl(callbackUrl, redirectUrl, state),
    ).toThrow(message);
  });

  test('accepts an authorization denial as a valid callback envelope', () => {
    const callbackUrl = `${redirectUrl}?error=access_denied&state=${state}`;

    expect(() =>
      validateOAuthCallbackUrl(callbackUrl, redirectUrl, state),
    ).not.toThrow();
    expect(() =>
      parseOAuthCallbackUrl(callbackUrl, redirectUrl, state),
    ).toThrow('OAuth authorization failed');
  });

  test('does not include provider-controlled error text in the exception', () => {
    expect(() =>
      parseOAuthCallbackUrl(
        `${redirectUrl}?error=%1B%5B31maccess_denied&state=${state}`,
        redirectUrl,
        state,
      ),
    ).toThrow(new Error('OAuth authorization failed'));
  });
});
