import { describe, expect, it, mock } from 'bun:test';
import { UpdateContext } from '../../../src/core/update-context.js';

const checkout = {
  path: '/cache/acme-tools',
  source: 'https://github.com/acme/tools.git',
  ref: 'refs/heads/main',
};

describe('UpdateContext', () => {
  it('coalesces concurrent work by complete physical identity', async () => {
    const context = new UpdateContext();
    const remoteLoader = mock(async () => ({ commit: 'a'.repeat(40) }));
    const healthLoader = mock(async () => ({ status: 'healthy' as const }));
    const applyLoader = mock(async () => ({ changed: false }));
    const remoteA = context.getRemote(
      'git@github.com:Acme/Tools.git',
      'refs/heads/main',
      remoteLoader,
    );
    const remoteB = context.getRemote(
      'https://github.com/acme/tools',
      'origin/main',
      remoteLoader,
    );
    const healthA = context.getHealth(checkout, healthLoader);
    const healthB = context.getHealth(
      {
        path: '/cache/acme-tools',
        source: 'git@github.com:Acme/Tools.git',
        ref: 'origin/main',
      },
      healthLoader,
    );
    const applyA = context.getApply(checkout, applyLoader);
    const applyB = context.getApply(
      {
        path: '/cache/acme-tools',
        source: 'git@github.com:Acme/Tools.git',
        ref: 'origin/main',
      },
      applyLoader,
    );

    expect(remoteA).toBe(remoteB);
    expect(healthA).toBe(healthB);
    expect(applyA).toBe(applyB);
    await Promise.all([
      remoteA,
      remoteB,
      healthA,
      healthB,
      applyA,
      applyB,
    ]);
    expect(remoteLoader).toHaveBeenCalledTimes(1);
    expect(healthLoader).toHaveBeenCalledTimes(1);
    expect(applyLoader).toHaveBeenCalledTimes(1);
  });

  it('does not share health or apply work across managed paths', async () => {
    const context = new UpdateContext();
    const healthLoader = mock(async () => ({ status: 'healthy' as const }));
    const applyLoader = mock(async () => ({ changed: false }));
    const other = { ...checkout, path: '/cache/acme-tools-other' };

    await Promise.all([
      context.getHealth(checkout, healthLoader),
      context.getHealth(other, healthLoader),
      context.getApply(checkout, applyLoader),
      context.getApply(other, applyLoader),
    ]);

    expect(healthLoader).toHaveBeenCalledTimes(2);
    expect(applyLoader).toHaveBeenCalledTimes(2);
  });

  it('rejects conflicting expected identities for one apply path', async () => {
    const context = new UpdateContext();
    const first = context.getApply(checkout, async () => ({ changed: false }));

    expect(
      context.getApply(
        { ...checkout, source: 'https://github.com/acme/other' },
        async () => ({ changed: true }),
      ),
    ).rejects.toThrow('Conflicting checkout identity');
    await expect(first).resolves.toEqual({ changed: false });
  });

  it('releases action state on disposal and a new context performs fresh work', async () => {
    const firstContext = new UpdateContext();
    const loader = mock(async () => ({ commit: 'a'.repeat(40) }));

    await firstContext.getRemote(checkout.source, checkout.ref, loader);
    firstContext.dispose();
    expect(() =>
      firstContext.getRemote(checkout.source, checkout.ref, loader),
    ).toThrow('disposed');

    const secondContext = new UpdateContext();
    await secondContext.getRemote(checkout.source, checkout.ref, loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
