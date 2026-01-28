#!/usr/bin/env bun
import { $ } from "bun";

type BumpType = "patch" | "minor" | "major";

const VALID_BUMP_TYPES = ["patch", "minor", "major"] as const;

async function main() {
  const bumpType = (process.argv[2] || "patch") as BumpType;

  // Validate bump type
  if (!VALID_BUMP_TYPES.includes(bumpType)) {
    console.error(`Error: Invalid bump type '${bumpType}'`);
    console.error("Usage: bun run release [patch|minor|major]");
    process.exit(1);
  }

  // Ensure we're on main branch
  const currentBranch = (await $`git branch --show-current`.text()).trim();
  if (currentBranch !== "main") {
    console.error(`Error: Must be on main branch (currently on '${currentBranch}')`);
    process.exit(1);
  }

  // Ensure working directory is clean
  const status = (await $`git status --porcelain`.text()).trim();
  if (status) {
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

  // Parse version components
  const [major, minor, patch] = currentVersion.split(".").map(Number);

  // Calculate new version
  let newVersion: string;
  switch (bumpType) {
    case "major":
      newVersion = `${major + 1}.0.0`;
      break;
    case "minor":
      newVersion = `${major}.${minor + 1}.0`;
      break;
    case "patch":
      newVersion = `${major}.${minor}.${patch + 1}`;
      break;
  }

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
  console.log(`  - Commit pushed to main`);
  console.log(`  - Tag ${tagName} pushed to origin`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
