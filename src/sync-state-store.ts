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
    readTextContent?: (path: string) => Promise<string | undefined>
  ): Promise<void> {
    const localMap = new Map(local.map((entry) => [entry.path, entry]));
    const remoteMap = new Map(remote.map((entry) => [entry.path, entry]));
    const paths = new Set<string>([...localMap.keys(), ...remoteMap.keys()]);

    const previousEntries = await Promise.all(
      [...paths].sort().map(async (path) => {
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

    this.state = {
      version: 1,
      lastSyncTime: Date.now(),
      previousEntries
    };

    await this.adapter.write(JSON.stringify(this.state, null, 2));
  }
}
