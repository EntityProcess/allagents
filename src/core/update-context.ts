import { resolve } from 'node:path';
import { gitSourceKey } from '../utils/git-source.js';

export interface CheckoutIdentity {
  path: string;
  source: string;
  ref?: string;
}

type Loader<T> = () => Promise<T>;

/** Action-scoped promise coalescing for immutable physical Git facts. */
export class UpdateContext {
  private readonly remotes = new Map<string, Promise<unknown>>();
  private readonly health = new Map<string, Promise<unknown>>();
  private readonly applies = new Map<string, Promise<unknown>>();
  private readonly applyIdentityByPath = new Map<string, string>();
  private disposed = false;

  getRemote<T>(source: string, ref: string | undefined, load: Loader<T>): Promise<T> {
    this.assertActive();
    return this.loadOnce(this.remotes, gitSourceKey(source, ref), load);
  }

  getHealth<T>(identity: CheckoutIdentity, load: Loader<T>): Promise<T> {
    this.assertActive();
    return this.loadOnce(this.health, this.checkoutKey(identity), load);
  }

  getApply<T>(identity: CheckoutIdentity, load: Loader<T>): Promise<T> {
    this.assertActive();
    const path = resolve(identity.path);
    const expectedIdentity = gitSourceKey(identity.source, identity.ref);
    const priorIdentity = this.applyIdentityByPath.get(path);
    if (priorIdentity && priorIdentity !== expectedIdentity) {
      return Promise.reject(
        new Error(`Conflicting checkout identity for managed path: ${path}`),
      );
    }
    this.applyIdentityByPath.set(path, expectedIdentity);
    return this.loadOnce(
      this.applies,
      JSON.stringify([path, expectedIdentity]),
      load,
    );
  }

  dispose(): void {
    this.remotes.clear();
    this.health.clear();
    this.applies.clear();
    this.applyIdentityByPath.clear();
    this.disposed = true;
  }

  private checkoutKey(identity: CheckoutIdentity): string {
    return JSON.stringify([
      resolve(identity.path),
      gitSourceKey(identity.source, identity.ref),
    ]);
  }

  private loadOnce<T>(
    cache: Map<string, Promise<unknown>>,
    key: string,
    load: Loader<T>,
  ): Promise<T> {
    const existing = cache.get(key);
    if (existing) return existing as Promise<T>;
    const promise = Promise.resolve().then(load);
    cache.set(key, promise);
    return promise;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Update context has been disposed');
  }
}
