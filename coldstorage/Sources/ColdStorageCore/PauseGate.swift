import Foundation

/// The daemon-level "uploads paused" latch (see PAUSE.md). The engine parks on `waitIfPaused()` at its two
/// dispatch points — between blobs, and between parts inside `PartShipper` — so a pause drains what is in
/// flight (≤ maxPartsInFlight × 64 MiB, each journaled as it lands) and then holds, wasting nothing.
/// `resume()` releases every parked waiter in place: same blob, same open multipart upload, next part.
///
/// An actor of its own (not `DaemonService` state) because the waiters live in the engine's run Task, a
/// different isolation domain — and because `DaemonService` is reentrant across awaits, so a latch it
/// managed itself would need the same care anyway, without the compiler proving it.
///
/// **Cancellation wins over pause.** `cancelRun` while parked must still stop the run promptly, so a parked
/// wait resumes by THROWING `CancellationError` — which the engine already classifies as `.stopped`. The
/// arrive-already-cancelled race is closed by the `Task.isCancelled` check at registration: the
/// continuation body runs synchronously on this actor in the waiting task, so either it sees the flag and
/// throws immediately, or the handler's `cancelWait` hop lands after registration and finds the waiter.
public actor PauseGate {
    public private(set) var paused = false
    private var waiters: [UUID: CheckedContinuation<Void, Error>] = [:]

    public init() {}

    public func pause() { paused = true }

    /// Clear the latch and release every parked waiter. Safe when nothing is parked.
    public func resume() {
        paused = false
        let released = waiters; waiters = [:]
        for w in released.values { w.resume() }
    }

    /// Park until `resume()` — or return immediately when not paused (the hot-path cost is one actor hop).
    /// Throws `CancellationError` if the surrounding task is cancelled, before or during the park.
    public func waitIfPaused() async throws {
        // Loop: a waiter released by `resume()` re-checks in case the gate was re-paused before it ran.
        while paused {
            let id = UUID()
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                    if Task.isCancelled { c.resume(throwing: CancellationError()); return }
                    guard paused else { c.resume(); return }   // resumed while we hopped onto the actor
                    waiters[id] = c
                }
            } onCancel: {
                Task { await self.cancelWait(id) }
            }
        }
    }

    /// A no-op when the waiter is already gone — released by `resume()`, or never registered because the
    /// registration saw the cancel flag first.
    private func cancelWait(_ id: UUID) {
        waiters.removeValue(forKey: id)?.resume(throwing: CancellationError())
    }
}
