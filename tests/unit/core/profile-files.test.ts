import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fingerprintProfileFile,
  materializeManagedFile,
  removeManagedFile,
  sha256Fingerprint,
} from '../../../src/core/profile/files.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'allagents-profile-files-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('managed profile files', () => {
  it('atomically creates and updates owned files with full pre/post fingerprints', async () => {
    const root = await temporaryRoot();
    const path = join(root, 'agent', 'settings.json');
    const created = await materializeManagedFile({
      root,
      path,
      content: '{"first":true}\n',
      mode: 0o600,
    });
    expect(created.status).toBe('created');
    expect(created.postFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);

    const updated = await materializeManagedFile({
      root,
      path,
      content: '{"second":true}\n',
      mode: 0o600,
      previousFingerprint: created.postFingerprint,
    });
    expect(updated).toEqual({
      status: 'updated',
      preFingerprint: created.postFingerprint,
      postFingerprint: sha256Fingerprint('{"second":true}\n'),
    });
    expect(await readFile(path, 'utf8')).toBe('{"second":true}\n');
  });

  it('refuses unowned collisions and modified managed-file overwrites', async () => {
    const root = await temporaryRoot();
    const path = join(root, 'AGENTS.md');
    await writeFile(path, 'mine');
    await expect(materializeManagedFile({
      root,
      path,
      content: 'desired',
      mode: 0o600,
    })).rejects.toThrow('unowned');
    await expect(materializeManagedFile({
      root,
      path,
      content: 'desired',
      mode: 0o600,
      previousFingerprint: sha256Fingerprint('previous managed bytes'),
    })).rejects.toThrow('modified');
    expect(await readFile(path, 'utf8')).toBe('mine');
  });

  it('does not replace an unowned file created at the publish boundary', async () => {
    const root = await temporaryRoot();
    const path = join(root, 'AGENTS.md');
    const originalLink = fsPromises.link;
    const originalRename = fsPromises.rename;
    let injected = false;
    const injectCompetingCreate = async () => {
      if (injected) return;
      injected = true;
      await writeFile(path, 'external create');
    };
    const linkSpy = spyOn(fsPromises, 'link').mockImplementation(async (from, to) => {
      if (to === path) await injectCompetingCreate();
      return originalLink(from, to);
    });
    const renameSpy = spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      if (to === path) await injectCompetingCreate();
      return originalRename(from, to);
    });

    try {
      await expect(materializeManagedFile({
        root,
        path,
        content: 'managed bytes',
        mode: 0o600,
      })).rejects.toThrow();
    } finally {
      linkSpy.mockRestore();
      renameSpy.mockRestore();
    }
    expect(injected).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('external create');
    expect(await readdir(root)).toEqual(['AGENTS.md']);
  });

  it('does not discard an external update made at the publish boundary', async () => {
    const root = await temporaryRoot();
    const path = join(root, 'AGENTS.md');
    await writeFile(path, 'managed before');
    const previousFingerprint = sha256Fingerprint('managed before');
    const originalRename = fsPromises.rename;
    let injected = false;
    const renameSpy = spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      if (!injected && (from === path || to === path)) {
        injected = true;
        await writeFile(path, 'external update');
      }
      return originalRename(from, to);
    });

    try {
      await expect(materializeManagedFile({
        root,
        path,
        content: 'managed after',
        mode: 0o600,
        previousFingerprint,
      })).rejects.toThrow('modified');
    } finally {
      renameSpy.mockRestore();
    }
    expect(injected).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('external update');
    expect(await readdir(root)).toEqual(['AGENTS.md']);
  });

  it('retains referenced and modified resources while removing corroborated managed files', async () => {
    const root = await temporaryRoot();
    const referenced = join(root, 'referenced.json');
    await writeFile(referenced, 'external');
    expect(await removeManagedFile({
      root,
      path: referenced,
      ownership: 'referenced',
    })).toEqual({ status: 'retained-referenced' });
    expect(await readFile(referenced, 'utf8')).toBe('external');

    const managed = join(root, 'managed.json');
    await writeFile(managed, 'managed');
    const expectedFingerprint = await fingerprintProfileFile(managed);
    if (!expectedFingerprint) throw new Error('expected fixture fingerprint');
    await writeFile(managed, 'user modification');
    const modified = await removeManagedFile({
      root,
      path: managed,
      ownership: 'managed',
      expectedFingerprint,
    });
    expect(modified.status).toBe('retained-modified');
    expect(await readFile(managed, 'utf8')).toBe('user modification');

    const currentFingerprint = await fingerprintProfileFile(managed);
    if (!currentFingerprint) throw new Error('expected modified fingerprint');
    expect(await removeManagedFile({
      root,
      path: managed,
      ownership: 'managed',
      expectedFingerprint: currentFingerprint,
    })).toEqual({
      status: 'removed',
      preFingerprint: currentFingerprint,
    });
    expect(await fingerprintProfileFile(managed)).toBeNull();
  });

  it('rejects escaped destinations, symlinked parents, symlink files, and a symlinked write root', async () => {
    const parent = await temporaryRoot();
    const root = join(parent, 'profile');
    const outside = join(parent, 'outside');
    await mkdir(root);
    await mkdir(outside);

    await expect(materializeManagedFile({
      root,
      path: join(parent, 'escape.txt'),
      content: 'escape',
      mode: 0o600,
    })).rejects.toThrow('escapes selected write root');

    await symlink(outside, join(root, 'linked-parent'));
    await expect(materializeManagedFile({
      root,
      path: join(root, 'linked-parent', 'file.txt'),
      content: 'unsafe',
      mode: 0o600,
    })).rejects.toThrow('symbolic link');

    await writeFile(join(outside, 'target.txt'), 'outside');
    await symlink(join(outside, 'target.txt'), join(root, 'linked-file'));
    await expect(removeManagedFile({
      root,
      path: join(root, 'linked-file'),
      ownership: 'managed',
      expectedFingerprint: sha256Fingerprint('outside'),
    })).rejects.toThrow('symbolic link');

    const rootLink = join(parent, 'profile-link');
    await symlink(root, rootLink);
    await expect(materializeManagedFile({
      root: rootLink,
      path: join(rootLink, 'new.txt'),
      content: 'unsafe root',
      mode: 0o600,
    })).rejects.toThrow('symbolic link');
  });

  it('uses deterministic full SHA-256 content fingerprints', () => {
    expect(sha256Fingerprint('test')).toBe(
      '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    );
    expect(sha256Fingerprint(Buffer.from('test'))).toBe(sha256Fingerprint('test'));
  });
});
