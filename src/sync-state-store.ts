import { FileEntry, PreviousEntry } from "./sync-planner";
import { canStoreMergeBase } from "./text-merge";

export interface SyncStateStoreAdapter {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

export interface SyncStateData {
  version: 1;
  lastSyncTime: number;
  previousEntries: PreviousEntry[];
}

export class SyncStateStore {
  private state: SyncStateData = {
    version: 1,
    lastSyncTime: 0,
    previousEntries: []
  };

  constructor(private readonly adapter: SyncStateStoreAdapter) {}

  async load(): Promise<void> {
    const raw = await this.adapter.read();
    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw) as SyncStateData | PreviousEntry[];
    if (Array.isArray(parsed)) {
      this.state = {
        version: 1,
        lastSyncTime: 0,
        previousEntries: parsed
      };
      return;
    }

    this.state = {
      version: 1,
      lastSyncTime: typeof parsed.lastSyncTime === "number" ? parsed.lastSyncTime : 0,
      previousEntries: Array.isArray(parsed.previousEntries)
        ? parsed.previousEntries
        : []
    };
  }

  getPreviousEntries(): PreviousEntry[] {
    return this.state.previousEntries.map((entry) => ({
      path: entry.path,
      local: entry.local ? { ...entry.local } : undefined,
      remote: entry.remote ? { ...entry.remote } : undefined,
      mergeBase: entry.mergeBase ? { ...entry.mergeBase } : undefined
    }));
  }

  getLastSyncTime(): number {
    return this.state.lastSyncTime;
  }

  async saveSuccessfulSync(
    local: FileEntry[],
    remote: FileEntry[],
    readTextContent?: (path: string) => Promise<string | undefined>,
    unresolvedPaths: Set<string> = new Set()
  ): Promise<void> {
    const localMap = new Map(local.map((entry) => [entry.path, entry]));
    const remoteMap = new Map(remote.map((entry) => [entry.path, entry]));
    const previousMap = new Map(
      this.state.previousEntries.map((entry) => [entry.path, entry])
    );

    // Resolved paths advance to the latest snapshot; unresolved ones are skipped
    // here and re-injected from the previous baseline below, so a pending
    // conflict's baseline is never clobbered with current disk state.
    const snapshotPaths = new Set<string>([...localMap.keys(), ...remoteMap.keys()]);
    const resolvedEntries = await Promise.all(
      [...snapshotPaths]
        .filter((path) => !unresolvedPaths.has(path))
        .sort()
        .map(async (path) => {
          const localEntry = localMap.get(path);
          const remoteEntry = remoteMap.get(path);
          const mergeBase =
            localEntry && remoteEntry && readTextContent && canStoreMergeBase(localEntry)
              ? await readTextContent(path).then((content) =>
                  typeof content === "string"
                    ? { source: "previous-sync-state" as const, content }
                    : undefined
                )
              : undefined;

          return {
            path,
            local: localEntry,
            remote: remoteEntry,
            mergeBase
          };
        })
    );

    // For every unresolved path, keep its previous baseline verbatim. If it has
    // no previous baseline (first-seen conflict), it is intentionally omitted so
    // it is not mistaken for already-synced next time.
    const preservedEntries: PreviousEntry[] = [];
    for (const path of unresolvedPaths) {
      const previous = previousMap.get(path);
      if (previous) {
        preservedEntries.push(previous);
      }
    }

    const previousEntries = [...resolvedEntries, ...preservedEntries].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    );

    this.state = {
      version: 1,
      lastSyncTime: Date.now(),
      previousEntries
    };

    await this.adapter.write(JSON.stringify(this.state, null, 2));
  }
}
