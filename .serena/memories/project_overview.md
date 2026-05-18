# remote-sync overview
- Obsidian plugin named `obsidian-webdav-sync`, currently focused on syncing normal vault files and attachments with remote storage.
- TypeScript project bundled by esbuild into `main.js`; Obsidian API is an external dependency.
- Main entry: `main.ts` (`RemoteSyncPlugin`) wires settings, local store, remote store, sync engine, commands, ribbon, and auto-sync.
- Settings UI and persisted schema live in `settings.ts`.
- Sync core is under `src/`: `sync-engine.ts`, `sync-planner.ts`, `sync-state-store.ts`, `local-store.ts`, `webdav-remote.ts`, `path-utils.ts`, `sync-types.ts`.
- Tests are Vitest files under `test/`.