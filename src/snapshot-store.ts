/**
 * Snapshot store backed by @oh-my-pi/hashline's InMemorySnapshotStore.
 * Tracks full-file content snapshots keyed by canonical path + 4-hex hash tag.
 * Used by read/edit/grep tools to anchor hashline operations.
 */
import { InMemorySnapshotStore } from "@oh-my-pi/hashline";

export function createSnapshotStore(): InMemorySnapshotStore {
	return new InMemorySnapshotStore({
		maxPaths: 200,
		maxVersionsPerPath: 4,
		maxTotalBytes: 64 * 1024 * 1024, // 64 MiB
	});
}
