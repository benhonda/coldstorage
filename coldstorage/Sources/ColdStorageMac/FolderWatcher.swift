#if canImport(CoreServices)
import Foundation
import CoreServices

/// macOS folder watcher (FSEvents). Coalesces filesystem changes under the watched roots and calls
/// `onChange` so the daemon can re-scan promptly instead of waiting out the poll interval. Apple-only
/// (FSEvents has no Linux equivalent), so it lives in the Mac adapter behind `canImport(CoreServices)`;
/// on Linux the daemon simply relies on its interval. Runtime-proven on a real Mac (2026-06-26): a drop
/// fires a sub-second re-scan under a 600s poll — see `task daemon:fsevents-test`.
///
/// Re-armable: `setPaths` tears down + rebuilds the stream when the watched set changes, so a folder
/// added via `addSource` (or unpaused) — which emits `sourcesChanged` — gets watched without a daemon
/// restart. All stream create/teardown is confined to `queue` (which also delivers the FSEvents
/// callbacks), so re-arms can't race each other or the initial arm — the trigger fans out from
/// `EventBus.publish` on any thread. (`@unchecked Sendable`: the only mutable state, `stream`/
/// `currentPaths`, is touched solely on `queue`.)
public final class FolderWatcher: @unchecked Sendable {
    private var stream: FSEventStreamRef?
    private var currentPaths: [String] = []
    private let onChange: () -> Void
    /// 1s latency batches bursts (a folder copy fires many events) into a single re-scan trigger.
    private let latency: CFTimeInterval = 1.0
    /// Serializes the stream lifecycle (create/start/stop/invalidate) and receives FSEvents callbacks —
    /// one serial queue for both means a callback can never overlap a teardown.
    private let queue = DispatchQueue(label: "com.theadpharm.coldstorage.folderwatcher")

    public init(onChange: @escaping () -> Void) { self.onChange = onChange }

    /// Arm — or re-arm — the watcher on exactly `paths` (folders only). Idempotent: a no-op if the set is
    /// unchanged; otherwise the old stream is torn down and a fresh one built. Safe to call from any thread.
    public func setPaths(_ paths: [String]) {
        queue.async { [weak self] in self?.rearm(paths) }
    }

    /// Initial arm. Alias for `setPaths` so startup reads naturally.
    public func start(paths: [String]) { setPaths(paths) }

    public func stop() { queue.async { [weak self] in self?.teardown() } }

    // MARK: - queue-confined (never call off `queue`)

    private func rearm(_ paths: [String]) {
        let next = Array(Set(paths)).sorted()
        guard next != currentPaths else { return }   // unchanged → keep the live stream, don't blink coverage
        teardown()
        currentPaths = next
        guard !next.isEmpty else { return }           // nothing to watch (all folders removed/paused)
        // Pass `self` through the C callback's context info pointer (FSEvents can't capture closures).
        var ctx = FSEventStreamContext(version: 0,
                                       info: Unmanaged.passUnretained(self).toOpaque(),
                                       retain: nil, release: nil, copyDescription: nil)
        let cb: FSEventStreamCallback = { _, info, count, _, _, _ in
            guard let info else { return }
            // Diagnostic so the FSEvents path is directly observable in `daemon:logs` (not inferred from
            // timing). Mirrors PhotoKitResolver's stderr breadcrumbs.
            FileHandle.standardError.write(Data("FolderWatcher: FSEvents fired (\(count) change(s)) → rescan.\n".utf8))
            Unmanaged<FolderWatcher>.fromOpaque(info).takeUnretainedValue().onChange()
        }
        guard let s = FSEventStreamCreate(kCFAllocatorDefault, cb, &ctx,
                                          next as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
                                          latency, FSEventStreamCreateFlags(kFSEventStreamCreateFlagNoDefer)) else { return }
        stream = s
        FSEventStreamSetDispatchQueue(s, queue)
        FSEventStreamStart(s)
    }

    private func teardown() {
        guard let s = stream else { return }
        FSEventStreamStop(s); FSEventStreamInvalidate(s); FSEventStreamRelease(s)
        stream = nil
    }
}
#endif
