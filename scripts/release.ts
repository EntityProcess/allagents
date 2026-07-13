#!/usr/bin/env bun
import { $ } from "bun";

type BumpType = "patch" | "minor" | "major";
type Channel = "stable" | "next" | "finalize";

interface FinalizeTarget {
  tag: string;
  commit: string;
  prereleaseVersion: string;
  stableVersion: string;
}

const VALID_BUMP_TYPES = ["patch", "minor", "major"] as const;
const PACKAGE_PATH = "package.json";

function parseNextPrerelease(
  version: string,
): { baseVersion: string; number: number } | null {
  const match = version.match(/^(\d+\.\d+\.\d+)-next\.(\d+)$/);
  if (!match) return null;
  return { baseVersion: match[1], number: Number.parseInt(match[2], 10) };
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function finalizeVersion(currentVersion: string): string {
  const parsed = parseNextPrerelease(currentVersion);
  if (!parsed) {
    fail(
      `Error: Version '${currentVersion}' is not a pre-release (expected X.Y.Z-next.N)`,
    );
  }
  return parsed.baseVersion;
}

function parseArgs(): {
  channel: Channel;
  bumpType?: BumpType;
  prereleaseTag?: string;
} {
  const args = process.argv.slice(2);

  if (args[0] === "finalize") {
    return { channel: "finalize", prereleaseTag: args[1] };
  }

  if (args[0] === "next") {
    const bumpType = args[1] as BumpType | undefined;
    if (bumpType && !VALID_BUMP_TYPES.includes(bumpType)) {
      fail(`Error: Invalid bump type '${bumpType}'
Usage: bun run release:next [patch|minor|major]`);
    }
    return { channel: "next", bumpType };
  }

  const bumpType = (args[0] || "patch") as BumpType;
  if (!VALID_BUMP_TYPES.includes(bumpType)) {
    fail(`Error: Invalid bump type '${bumpType}'
Usage: bun run release [patch|minor|major]`);
  }
  return { channel: "stable", bumpType };
}

function bumpVersion(currentVersion: string, bumpType: BumpType): string {
  const stablePart = currentVersion.split("-")[0];
  const [major, minor, patch] = stablePart.split(".").map(Number);

  switch (bumpType) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
  }
}

function bumpNextVersion(
  currentVersion: string,
  bumpType?: BumpType,
): string {
  const parsedNext = parseNextPrerelease(currentVersion);

  // Already on a -next.N version and no explicit bump -> increment counter
  if (parsedNext && !bumpType) {
    return `${parsedNext.baseVersion}-next.${parsedNext.number + 1}`;
  }

  // Explicit bump type or not currently on a next version -> start new prerelease
  const baseBump = bumpType ?? "patch";
  const baseVersion = parsedNext ? parsedNext.baseVersion : currentVersion;
  const bumpedBase = bumpVersion(baseVersion, baseBump);
  return `${bumpedBase}-next.1`;
}

function normalizePrereleaseTag(tag: string): string {
  return tag.startsWith("v") ? tag : `v${tag}`;
}

async function currentBranch(): Promise<string> {
  return (await $`git branch --show-current`.text()).trim();
}

async function commitForRef(ref: string): Promise<string> {
  return (await $`git rev-list -n 1 ${ref}`.text()).trim();
}

async function packageJsonAtRef(ref: string): Promise<{ version: string }> {
  const packageRef = `${ref}:${PACKAGE_PATH}`;
  return JSON.parse(await $`git show ${packageRef}`.text()) as {
    version: string;
  };
}

function shortCommit(commit: string): string {
  return commit.slice(0, 12);
}

async function isAncestor(
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result =
    await $`git merge-base --is-ancestor ${ancestor} ${descendant}`.nothrow();
  return result.exitCode === 0;
}

async function resolveLatestPrereleaseTag(): Promise<string> {
  const tag = (await $`git tag --list v*-next.* --sort=-version:refname`.text())
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);

  if (!tag) {
    fail("Error: No prerelease tag found to finalize");
  }

  return tag;
}

async function resolveFinalizeTarget(
  explicitTag?: string,
): Promise<FinalizeTarget> {
  const tag = explicitTag
    ? normalizePrereleaseTag(explicitTag)
    : await resolveLatestPrereleaseTag();
  const existingTag = (await $`git tag -l ${tag}`.text()).trim();

  if (!existingTag) {
    fail(`Error: Prerelease tag '${tag}' does not exist`);
  }

  const pkgAtTag = await packageJsonAtRef(tag);
  const parsedVersion = parseNextPrerelease(pkgAtTag.version);
  if (!parsedVersion) {
    fail(
      `Error: Tag '${tag}' does not point to a pre-release version (found ${pkgAtTag.version})`,
    );
  }

  return {
    tag,
    commit: await commitForRef(tag),
    prereleaseVersion: pkgAtTag.version,
    stableVersion: parsedVersion.baseVersion,
  };
}

async function prepareFinalizeMain(target: FinalizeTarget): Promise<void> {
  const branch = await currentBranch();
  if (branch !== "main") {
    fail(
      `Error: Finalize must run on main so the stable version commit can be pushed (currently on '${branch}')`,
    );
  }

  console.log("Pulling latest changes...");
  await $`git pull --ff-only origin main`;

  const head = (await $`git rev-parse HEAD`.text()).trim();
  const releaseTag = `v${target.stableVersion}`;
  const existingReleaseTag = (await $`git tag -l ${releaseTag}`.text()).trim();

  if (existingReleaseTag && head === (await commitForRef(releaseTag))) {
    return;
  }

  if (head !== target.commit) {
    fail(
      `Error: Cannot finalize ${target.tag} because main is at ${shortCommit(head)}, not ${shortCommit(target.commit)}. Create a new prerelease from current main, or finalize before additional commits land on main.`,
    );
  }
}

async function ensureFinalizeMainStillMatches(
  target: FinalizeTarget,
  currentVersion: string,
): Promise<void> {
  const head = (await $`git rev-parse HEAD`.text()).trim();
  if (head !== target.commit) {
    fail(
      `Error: Cannot finalize ${target.tag} because main is at ${shortCommit(head)}, not ${shortCommit(target.commit)}.`,
    );
  }

  if (currentVersion !== target.prereleaseVersion) {
    fail(
      `Error: Cannot finalize ${target.tag} because ${PACKAGE_PATH} on main is ${currentVersion}, but the prerelease tag contains ${target.prereleaseVersion}.`,
    );
  }
}

async function finishExistingFinalizeTag(
  target: FinalizeTarget,
  newVersion: string,
): Promise<void> {
  const releaseTag = `v${newVersion}`;
  const pkgAtReleaseTag = await packageJsonAtRef(releaseTag);
  if (pkgAtReleaseTag.version !== newVersion) {
    fail(
      `Error: Tag '${releaseTag}' already exists, but ${PACKAGE_PATH} contains version ${pkgAtReleaseTag.version}`,
    );
  }

  const head = (await $`git rev-parse HEAD`.text()).trim();
  const releaseCommit = await commitForRef(releaseTag);

  if (head === releaseCommit) {
    console.log(`Tag '${releaseTag}' already exists with version ${newVersion}`);
    console.log(`Release tag ${releaseTag} already exists on main; continuing`);
    return;
  }

  if (head !== target.commit) {
    fail(
      `Error: Tag '${releaseTag}' already exists, but main is at ${shortCommit(head)} instead of ${shortCommit(target.commit)} or ${shortCommit(releaseCommit)}.`,
    );
  }

  if (!(await isAncestor(head, releaseCommit))) {
    fail(
      `Error: Tag '${releaseTag}' already exists, but it cannot be fast-forwarded from ${target.tag} on main.`,
    );
  }

  console.log(`Tag '${releaseTag}' already exists with version ${newVersion}`);
  console.log(`Fast-forwarding main to existing release tag ${releaseTag}...`);
  await $`git merge --ff-only ${releaseCommit}`;

  console.log("Pushing main to origin...");
  await $`git push --no-verify origin main`;

  console.log(`Release tag ${releaseTag} already exists; main now contains ${newVersion}`);
}

async function main() {
  const { channel, bumpType, prereleaseTag } = parseArgs();

  // Ensure working directory is clean (ignore untracked files)
  const status = (await $`git status --porcelain`.text()).trim();
  const trackedChanges = status
    .split("\n")
    .filter((line) => line && !line.startsWith("??"));
  if (trackedChanges.length > 0) {
    console.error("Error: Working directory has uncommitted changes");
    console.error("Please commit or stash changes before releasing");
    process.exit(1);
  }

  let finalizeTarget: FinalizeTarget | undefined;
  if (channel === "finalize") {
    console.log("Fetching latest tags...");
    await $`git fetch origin --tags`;
    finalizeTarget = await resolveFinalizeTarget(prereleaseTag);
    await prepareFinalizeMain(finalizeTarget);
  } else {
    // Ensure we're on main branch
    const branch = await currentBranch();
    if (branch !== "main") {
      console.error(
        `Error: Must be on main branch (currently on '${branch}')`,
      );
      process.exit(1);
    }

    // Pull latest changes
    console.log("Pulling latest changes...");
    await $`git pull origin main`;
  }

  // Read and parse current version
  const pkg = await Bun.file(PACKAGE_PATH).json();
  const currentVersion: string = pkg.version;
  console.log(`Current version: ${currentVersion}`);

  // Calculate new version
  const newVersion =
    channel === "next"
      ? bumpNextVersion(currentVersion, bumpType)
      : channel === "finalize"
        ? (finalizeTarget?.stableVersion ?? finalizeVersion(currentVersion))
        : bumpVersion(currentVersion, bumpType!);

  const tagName = `v${newVersion}`;
  console.log(`Bumping version: ${currentVersion} -> ${newVersion}`);

  // Check if tag already exists
  const existingTag = (await $`git tag -l ${tagName}`.text()).trim();
  if (existingTag) {
    if (channel === "finalize") {
      if (!finalizeTarget) {
        fail("Error: Finalize target was not resolved");
      }
      await finishExistingFinalizeTag(finalizeTarget, newVersion);
      return;
    }

    console.error(`Error: Tag '${tagName}' already exists`);
    process.exit(1);
  }

  if (channel === "finalize") {
    if (!finalizeTarget) {
      fail("Error: Finalize target was not resolved");
    }
    await ensureFinalizeMainStillMatches(finalizeTarget, currentVersion);
  }

  // Update package.json
  pkg.version = newVersion;
  await Bun.write(PACKAGE_PATH, `${JSON.stringify(pkg, null, 2)}\n`);

  // Commit the version bump (skip hooks — this is just a version bump)
  await $`git add ${PACKAGE_PATH}`;
  await $`git commit --no-verify -m ${"chore(release): bump version to " + newVersion}`;

  // Create annotated tag
  await $`git tag -a ${tagName} -m ${"Release " + newVersion}`;
  console.log(`Created tag: ${tagName}`);

  // Push commit and tag (skip hooks — already validated before release)
  console.log("Pushing to origin...");
  await $`git push --no-verify origin main`;
  await $`git push --no-verify origin ${tagName}`;

  console.log("");
  console.log(`Release ${newVersion} completed successfully!`);
  console.log("  - Commit pushed to main");
  console.log(`  - Tag ${tagName} pushed to origin`);
  console.log("");
  console.log("Next steps:");
  console.log("  1. Publish from the pushed release tag");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
