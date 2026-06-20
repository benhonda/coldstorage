import Foundation

/// A live event the daemon pushes to control-plane clients (progress, state changes).
/// `data` is flat string→string — enough for V1 (file/blob ids, counts); structured later if needed.
public struct DaemonEvent: Sendable {
    public let name: String
    public let data: [String: String]
    public init(_ name: String, _ data: [String: String] = [:]) { self.name = name; self.data = data }
}

/// Decouples event *producers* (the daemon) from *consumers* (the control server's connections).
/// Lock-based (not an actor) so producers on any thread/actor can `publish` synchronously without
/// `await` — fan-out is cheap and sinks do their own (non-blocking) writes.
public final class EventBus: @unchecked Sendable {
    private let lock = NSLock()
    private var sinks: [Int: @Sendable (DaemonEvent) -> Void] = [:]
    private var next = 0

    public init() {}

    public func publish(_ e: DaemonEvent) {
        lock.lock(); let current = Array(sinks.values); lock.unlock()
        for s in current { s(e) }   // outside the lock: a slow sink can't stall other producers
    }

    @discardableResult
    public func subscribe(_ sink: @escaping @Sendable (DaemonEvent) -> Void) -> Int {
        lock.lock(); defer { lock.unlock() }
        let id = next; next += 1; sinks[id] = sink; return id
    }

    public func unsubscribe(_ id: Int) { lock.lock(); sinks[id] = nil; lock.unlock() }
}
