import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectPiMcpAdapter } from '../../../../src/core/native/pi-mcp.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'allagents-pi-mcp-'));
  temporaryDirectories.push(base);
  const selectedRoot = join(base, 'selected-agent');
  mkdirSync(selectedRoot, { recursive: true });
  return { base, selectedRoot };
}

function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function installAdapter(
  root: string,
  manifest: Record<string, unknown> = {
    name: 'pi-mcp-adapter',
    version: '2.33.0',
    pi: { extensions: ['./index.ts'] },
  },
) {
  const packageRoot = join(
    root,
    'npm',
    'node_modules',
    'pi-mcp-adapter',
  );
  mkdirSync(packageRoot, { recursive: true });
  writeJson(join(packageRoot, 'package.json'), manifest);
  writeFileSync(join(packageRoot, 'index.ts'), 'export default function adapter() {}\n');
  return packageRoot;
}

describe('native/pi-mcp', () => {
  test('classifies a configured same-root package with an enabled contained extension as usable', async () => {
    const { selectedRoot } = fixture();
    writeJson(join(selectedRoot, 'settings.json'), {
      packages: ['npm:pi-mcp-adapter'],
    });
    const packageRoot = installAdapter(selectedRoot);

    expect(await inspectPiMcpAdapter(selectedRoot)).toEqual({
      classification: 'usable',
      root: selectedRoot,
      packageSource: 'npm:pi-mcp-adapter',
      packagePath: packageRoot,
      manifestPath: join(packageRoot, 'package.json'),
      version: '2.33.0',
      extensionPath: join(packageRoot, 'index.ts'),
    });
  });

  test('classifies an unconfigured PATH-only adapter as absent', async () => {
    const { base, selectedRoot } = fixture();
    const bin = join(base, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'pi-mcp-adapter'), '#!/bin/sh\nexit 0\n');
    writeJson(join(selectedRoot, 'settings.json'), { packages: [] });

    expect((await inspectPiMcpAdapter(selectedRoot)).classification).toBe(
      'absent',
    );
  });

  test('does not credit a package installed and configured in another Pi root', async () => {
    const { base, selectedRoot } = fixture();
    const otherRoot = join(base, 'other-agent');
    mkdirSync(otherRoot, { recursive: true });
    writeJson(join(otherRoot, 'settings.json'), {
      packages: ['npm:pi-mcp-adapter'],
    });
    installAdapter(otherRoot);
    writeJson(join(selectedRoot, 'settings.json'), { packages: [] });

    expect((await inspectPiMcpAdapter(selectedRoot)).classification).toBe(
      'absent',
    );
  });

  test('distinguishes configured-missing and installed-disabled packages', async () => {
    const missing = fixture();
    writeJson(join(missing.selectedRoot, 'settings.json'), {
      packages: ['npm:pi-mcp-adapter'],
    });
    expect(
      (await inspectPiMcpAdapter(missing.selectedRoot)).classification,
    ).toBe('configured-missing');

    const disabled = fixture();
    writeJson(join(disabled.selectedRoot, 'settings.json'), {
      packages: [
        { source: 'npm:pi-mcp-adapter', extensions: [] },
      ],
    });
    installAdapter(disabled.selectedRoot);
    expect(
      (await inspectPiMcpAdapter(disabled.selectedRoot)).classification,
    ).toBe('installed-disabled');
  });

  test('honors autoload false extension includes without enabling omitted resources', async () => {
    const { selectedRoot } = fixture();
    writeJson(join(selectedRoot, 'settings.json'), {
      packages: [
        {
          source: 'npm:pi-mcp-adapter',
          autoload: false,
          extensions: ['+index.ts'],
        },
      ],
    });
    installAdapter(selectedRoot);

    expect((await inspectPiMcpAdapter(selectedRoot)).classification).toBe(
      'usable',
    );
  });

  test('fails inspection for malformed or wrong-name installed manifests', async () => {
    const malformed = fixture();
    writeJson(join(malformed.selectedRoot, 'settings.json'), {
      packages: ['npm:pi-mcp-adapter'],
    });
    const malformedPackage = installAdapter(malformed.selectedRoot);
    writeFileSync(join(malformedPackage, 'package.json'), '{');
    expect(
      (await inspectPiMcpAdapter(malformed.selectedRoot)).classification,
    ).toBe('inspection-failed');

    const wrongName = fixture();
    writeJson(join(wrongName.selectedRoot, 'settings.json'), {
      packages: ['npm:pi-mcp-adapter'],
    });
    installAdapter(wrongName.selectedRoot, {
      name: 'not-the-adapter',
      version: '2.33.0',
      pi: { extensions: ['./index.ts'] },
    });
    expect(
      (await inspectPiMcpAdapter(wrongName.selectedRoot)).classification,
    ).toBe('inspection-failed');
  });

  test('fails inspection when the configured package or extension escapes the selected root', async () => {
    const externalPackage = fixture();
    const outside = join(externalPackage.base, 'outside-package');
    mkdirSync(outside, { recursive: true });
    writeJson(join(outside, 'package.json'), {
      name: 'pi-mcp-adapter',
      version: '2.33.0',
      pi: { extensions: ['./index.ts'] },
    });
    writeFileSync(join(outside, 'index.ts'), 'export default function adapter() {}\n');
    writeJson(join(externalPackage.selectedRoot, 'settings.json'), {
      packages: [outside],
    });
    expect(
      (await inspectPiMcpAdapter(externalPackage.selectedRoot)).classification,
    ).toBe('inspection-failed');

    const escapingExtension = fixture();
    writeJson(join(escapingExtension.selectedRoot, 'settings.json'), {
      packages: ['npm:pi-mcp-adapter'],
    });
    const packageRoot = installAdapter(escapingExtension.selectedRoot);
    const externalExtension = join(escapingExtension.base, 'external.ts');
    writeFileSync(externalExtension, 'export default function adapter() {}\n');
    rmSync(join(packageRoot, 'index.ts'));
    symlinkSync(externalExtension, join(packageRoot, 'index.ts'));
    const result = await inspectPiMcpAdapter(escapingExtension.selectedRoot);
    expect(result.classification).toBe('inspection-failed');
    expect(result.error).toContain('escapes the selected Pi root');
  });

  test('performs inspection without writing package, init, or MCP state', async () => {
    const { selectedRoot } = fixture();
    const settingsPath = join(selectedRoot, 'settings.json');
    writeJson(settingsPath, { packages: ['npm:pi-mcp-adapter'] });
    installAdapter(selectedRoot);
    const beforeEntries = readdirSync(selectedRoot, { recursive: true })
      .map(String)
      .sort();
    const beforeSettings = readFileSync(settingsPath, 'utf8');

    const result = await inspectPiMcpAdapter(selectedRoot);

    expect(result.classification).toBe('usable');
    expect(readdirSync(selectedRoot, { recursive: true }).map(String).sort()).toEqual(
      beforeEntries,
    );
    expect(readFileSync(settingsPath, 'utf8')).toBe(beforeSettings);
    expect(beforeEntries.some((entry) => entry.includes('mcp.json'))).toBe(false);
  });
});
