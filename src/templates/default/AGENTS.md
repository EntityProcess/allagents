<!-- WORKSPACE-RULES:START -->
# Workspace Rules

## Rule: Workspace Discovery
TRIGGER: Any task
ACTION: Read `.allagents/workspace.yaml` to get repository paths and project domains

## Rule: Correct Repository Paths
TRIGGER: File operations (read, search, modify)
ACTION: Use repository paths from `.allagents/workspace.yaml`, not assumptions
<!-- WORKSPACE-RULES:END -->
