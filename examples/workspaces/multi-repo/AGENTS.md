<!-- WORKSPACE-RULES:START -->
# Workspace Rules

## Rule: Workspace Discovery
TRIGGER: Any task
ACTION: Read `workspace.yaml` to get repository paths and project domains

## Rule: Correct Repository Paths
TRIGGER: File operations (read, search, modify)
ACTION: Use repository paths from `workspace.yaml`, not assumptions

## Rule: Cross-Repository Context
TRIGGER: Tasks involving multiple repositories
ACTION: Check all repository paths in workspace.yaml before making changes
<!-- WORKSPACE-RULES:END -->
