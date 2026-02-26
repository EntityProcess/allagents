#!/usr/bin/env bun
import { $ } from "bun";

type BumpType = "patch" | "minor" | "major";
type Channel = "stable" | "next";

const VALID_BUMP_TYPES = ["patch", "minor", "major"] as const;

function parseArgs(): { channel: Channel; bumpType?: BumpType } {
  const args = process.argv.slice(2);

  if (args[0] === "next") {
    const bumpType = args[1] as BumpType | undefined;
    if (bumpType && !VALID_BUMP_TYPES.includes(bumpType)) {
      console.error(`Error: Invalid bump type '${bumpType}'`);
      console.error(
        "Usage: bun run release:next [patch|minor|major]",
      );
      process.exit(1);
    }
    return { channel: "next", bumpType };
  }

  const bumpType = (args[0] || "patch") as BumpType;
  if (!VALID_BUMP_TYPES.includes(bumpType)) {
    console.error(`Error: Invalid bump type '${bumpType}'`);
    console.error("Usage: bun run release [patch|minor|major]");
    process.exit(1);
  }
  return { channel: "stable", bumpType };
}

function parseNextPrerelease(
  version: string,
): { baseVersion: string; number: number } | null {
  const match = version.match(/^(\d+\.\d+\.\d+)-next\.(\d+)$/);
  if (!match) return null;
  return { baseVersion: match[1], number: Number(match[2]) };
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

async function main() {
  const { channel, bumpType } = parseArgs();

  // Ensure we're on main branch
  const currentBranch = (await $`git branch --show-current`.text()).trim();
  if (currentBranch !== "main") {
    console.error(
      `Error: Must be on main branch (currently on '${currentBranch}')`,
    );
    process.exit(1);
  }

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

  // Pull latest changes
  console.log("Pulling latest changes...");
  await $`git pull origin main`;

  // Read and parse current version
  const pkg = await Bun.file("package.json").json();
  const currentVersion: string = pkg.version;
  console.log(`Current version: ${currentVersion}`);

  // Calculate new version
  const newVersion =
    channel === "next"
      ? bumpNextVersion(currentVersion, bumpType)
      : bumpVersion(currentVersion, bumpType!);

  const tagName = `v${newVersion}`;
  console.log(`Bumping version: ${currentVersion} -> ${newVersion}`);

  // Check if tag already exists
  try {
    await $`git rev-parse ${tagName}`.quiet();
    console.error(`Error: Tag '${tagName}' already exists`);
    process.exit(1);
  } catch {
    // Tag doesn't exist, continue
  }

  // Update package.json
  pkg.version = newVersion;
  await Bun.write("package.json", JSON.stringify(pkg, null, 2) + "\n");

  // Commit the version bump
  await $`git add package.json`;
  await $`git commit -m ${"chore(release): bump version to " + newVersion}`;

  // Create annotated tag
  await $`git tag -a ${tagName} -m ${"Release " + newVersion}`;
  console.log(`Created tag: ${tagName}`);

  // Push commit and tag
  console.log("Pushing to origin...");
  await $`git push origin main`;
  await $`git push origin ${tagName}`;

  console.log("");
  console.log(`Release ${newVersion} completed successfully!`);
  console.log("  - Commit pushed to main");
  console.log(`  - Tag ${tagName} pushed to origin`);

  if (channel === "next") {
    console.log("");
    console.log("Next steps:");
    console.log("  1. Run: bun run publish:next");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
