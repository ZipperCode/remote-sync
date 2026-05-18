# Code style
- TypeScript with `strictNullChecks` and `noImplicitAny`; prefer explicit interfaces for persisted settings and sync contracts.
- Existing code uses double quotes, semicolons, and named exports.
- Keep remote storage behind `SyncRemoteStore` so `SyncEngine` remains provider-agnostic.
- Obsidian settings UI is built imperatively with `Setting`, `addText`, `addTextArea`, `addDropdown`, and buttons.
- Avoid introducing large SDK dependencies unless required; current project is lightweight and only has dev dependencies.