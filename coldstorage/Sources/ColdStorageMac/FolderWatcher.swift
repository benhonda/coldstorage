#if canImport(CoreServices)
import Foundation
import CoreServices

/// macOS folder watcher (FSEvents). Coalesces filesystem changes under the watched roots and calls
/// `onChange` so the daemon can re-scan promptly instead of waiting out the poll interval. Apple-only
/// (FSEvents has no Linux equivalent), so it lives in the Mac adapter behind `canImport(CoreServices)`;
/// on Linux the daemon simply relies on its interval. Untested on a real Mac yet (see ROADMAP).
public final class FolderWatcher {
    private var stream: FSEventStreamRef?
    private let onChange: () -> Void
    /// 1s latency batches bursts (a folder copy fires many events) into a single re-scan trigger.
    private let latency: CFTimeInterval = 1.0

    public init(onChange: @escaping () -> Void) { self.onChange = onChange }

    public func start(paths: [String]) {
        guard !paths.isEmpty, stream == nil else { return }
        // Pass `self` through the C callback's context info pointer (FSEvents can't capture closures).
        var ctx = FSEventStreamContext(version: 0,
                                       info: Unmanaged.passUnretained(self).toOpaque(),
                                       retain: nil, release: nil, copyDescription: nil)
        let cb: FSEventStreamCallback = { _, info, _, _, _, _ in
            guard let info else { return }
            Unmanaged<FolderWatcher>.fromOpaque(info).takeUnretainedValue().onChange()
        }
        guard let s = FSEventStreamCreate(kCFAllocatorDefault, cb, &ctx,
                                          paths as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
                                          latency, FSEventStreamCreateFlags(kFSEventStreamCreateFlagNoDefer)) else { return }
        stream = s
        FSEventStreamSetDispatchQueue(s, DispatchQueue.global(qos: .utility))
        FSEventStreamStart(s)
    }

    public func stop() {
        guard let s = stream else { return }
        FSEventStreamStop(s); FSEventStreamInvalidate(s); FSEventStreamRelease(s)
        stream = nil
    }
}
#endif
