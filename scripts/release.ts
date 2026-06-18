#!/usr/bin/env bun
import { $ } from "bun";

type BumpType = "patch" | "minor" | "major";
type Channel = "stable" | "next" | "finalize";

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

async function resolveFinalizeTag(explicitTag?: string): Promise<string> {
  const tag = explicitTag
    ? normalizePrereleaseTag(explicitTag)
    : await resolveLatestPrereleaseTag();
  const existingTag = (await $`git tag -l ${tag}`.text()).trim();

  if (!existingTag) {
    fail(`Error: Prerelease tag '${tag}' does not exist`);
  }

  const packageRef = `${tag}:${PACKAGE_PATH}`;
  const pkgAtTag = JSON.parse(await $`git show ${packageRef}`.text()) as {
    version: string;
  };
  if (!parseNextPrerelease(pkgAtTag.version)) {
    fail(
      `Error: Tag '${tag}' does not point to a pre-release version (found ${pkgAtTag.version})`,
    );
  }

  return tag;
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

  let resolvedFinalizeTag: string | undefined;
  if (channel === "finalize") {
    console.log("Fetching latest tags...");
    await $`git fetch origin --tags`;
    resolvedFinalizeTag = await resolveFinalizeTag(prereleaseTag);

    console.log(`Checking out prerelease tag ${resolvedFinalizeTag}...`);
    await $`git checkout --detach ${resolvedFinalizeTag}`;
  } else {
    // Ensure we're on main branch
    const currentBranch = (await $`git branch --show-current`.text()).trim();
    if (currentBranch !== "main") {
      console.error(
        `Error: Must be on main branch (currently on '${currentBranch}')`,
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
        ? finalizeVersion(currentVersion)
        : bumpVersion(currentVersion, bumpType!);

  const tagName = `v${newVersion}`;
  console.log(`Bumping version: ${currentVersion} -> ${newVersion}`);

  // Check if tag already exists
  const existingTag = (await $`git tag -l ${tagName}`.text()).trim();
  if (existingTag) {
    if (channel === "finalize") {
      const packageRef = `${tagName}:${PACKAGE_PATH}`;
      const pkgAtTag = JSON.parse(await $`git show ${packageRef}`.text()) as {
        version: string;
      };

      if (pkgAtTag.version === newVersion) {
        console.log(`Tag '${tagName}' already exists with version ${newVersion}`);
        console.log(`Checking out existing release tag ${tagName}...`);
        await $`git checkout --detach ${tagName}`;
        console.log("");
        console.log(`Release tag ${tagName} already exists; continuing`);
        return;
      }

      console.error(
        `Error: Tag '${tagName}' already exists, but package.json contains version ${pkgAtTag.version}`,
      );
      process.exit(1);
    }

    console.error(`Error: Tag '${tagName}' already exists`);
    process.exit(1);
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
  if (channel !== "finalize") {
    await $`git push --no-verify origin main`;
  }
  await $`git push --no-verify origin ${tagName}`;

  console.log("");
  console.log(`Release ${newVersion} completed successfully!`);
  if (channel !== "finalize") {
    console.log("  - Commit pushed to main");
  }
  console.log(`  - Tag ${tagName} pushed to origin`);
  console.log("");
  console.log("Next steps:");
  console.log("  1. Publish from the pushed release tag");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
