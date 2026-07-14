import Foundation
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

/// Local unix-domain socket control plane for `coldstored` (design §9). Newline-delimited JSON:
/// each client line is a `ControlRequest`; we reply with a `ControlResponseLine` (same id) and also
/// push `ControlEventLine`s as the daemon makes progress. The journal stays the source of truth —
/// this is just transport + dispatch.
///
/// Implemented with blocking POSIX I/O on dedicated `Thread`s (not the cooperative pool): one accept
/// thread, one read thread per connection. The async command `handler` (the daemon actor) is reached
/// via a semaphore bridge. A single `EventBus` subscription fans events to every live connection.
public final class ControlServer: @unchecked Sendable {
    /// One connected client. Writes (responses + events) are serialized by `lock`.
    private final class Conn: @unchecked Sendable {
        let fd: Int32
        let lock = NSLock()
        var closed = false
        init(_ fd: Int32) { self.fd = fd }
        func send(_ data: Data) {
            lock.lock(); defer { lock.unlock() }
            guard !closed else { return }
            if !UnixSocket.writeAll(fd, data) { closed = true }
        }
        func shut() {
            lock.lock(); defer { lock.unlock() }
            if !closed { closed = true; close(fd) }
        }
    }

    let path: String
    let bus: EventBus
    let handler: @Sendable (ControlRequest) async -> ControlResponseLine
    private let lock = NSLock()
    private var conns: [ObjectIdentifier: Conn] = [:]
    private var listenFD: Int32 = -1

    public init(path: String, bus: EventBus,
                handler: @escaping @Sendable (ControlRequest) async -> ControlResponseLine) {
        self.path = path; self.bus = bus; self.handler = handler
    }

    public func start() throws {
        signal(SIGPIPE, SIG_IGN)        // a write to a vanished client must never kill the daemon
        unlink(path)                    // clear a stale socket from a prior run
        let fd = try UnixSocket.openSocket()
        var (addr, len) = try UnixSocket.address(path)
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) }
        }
        guard ok == 0 else { close(fd); throw ColdStorageError.invalidRequest("bind(\(path)): errno \(errno)") }
        chmod(path, 0o600)              // owner-only — the local-peer auth the design asks for
        guard listen(fd, 16) == 0 else { close(fd); throw ColdStorageError.invalidRequest("listen(): errno \(errno)") }
        listenFD = fd
        bus.subscribe { [weak self] e in self?.broadcast(e) }
        Thread { [weak self] in self?.acceptLoop(fd) }.start()
    }

    public func stop() {
        if listenFD >= 0 { close(listenFD); listenFD = -1 }   // unblocks accept() → thread exits
        unlink(path)
        lock.lock(); let all = Array(conns.values); conns.removeAll(); lock.unlock()
        for c in all { c.shut() }
    }

    // MARK: - threads

    private func acceptLoop(_ fd: Int32) {
        while true {
            let cfd = accept(fd, nil, nil)
            if cfd < 0 { return }       // listen fd closed (stop) or fatal → exit
            let conn = Conn(cfd)
            let oid = ObjectIdentifier(conn)
            lock.lock(); conns[oid] = conn; lock.unlock()
            Thread { [weak self] in self?.readLoop(conn, oid) }.start()
        }
    }

    private func readLoop(_ conn: Conn, _ oid: ObjectIdentifier) {
        var buf = Data()
        var chunk = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = read(conn.fd, &chunk, chunk.count)
            if n <= 0 { break }         // EOF or error
            buf.append(contentsOf: chunk[0..<n])
            while let nl = buf.firstIndex(of: 0x0A) {
                let line = buf.subdata(in: buf.startIndex..<nl)
                buf.removeSubrange(buf.startIndex...nl)
                handleLine(line, conn)
            }
        }
        lock.lock(); conns[oid] = nil; lock.unlock()
        conn.shut()
    }

    // MARK: - dispatch

    private func handleLine(_ line: Data, _ conn: Conn) {
        guard !line.isEmpty else { return }
        guard let req = try? JSONDecoder().decode(ControlRequest.self, from: line) else {
            send(ControlResponseLine(id: 0, result: nil, error: "malformed request"), to: conn)
            return
        }
        // Run the async handler on the concurrency pool — never block the read thread on it. The old
        // `DispatchSemaphore.wait()`-gates-`Task.detached` bridge was a forward-progress hazard that
        // hung under load. The reply is written from the Task; `Conn` serializes writes, so ordering
        // vs. pushed events stays correct.
        Task { [weak self] in
            guard let self else { return }
            self.send(await self.handler(req), to: conn)
        }
    }

    /// Encode + frame a response/line and write it (a fresh encoder — JSONEncoder isn't concurrency-safe).
    private func send(_ resp: ControlResponseLine, to conn: Conn) {
        if let data = try? JSONEncoder().encode(resp) { conn.send(data + Data([0x0A])) }
    }

    private func broadcast(_ e: DaemonEvent) {
        guard let data = try? JSONEncoder().encode(ControlEventLine(event: e.name, data: e.data)) else { return }
        let payload = data + Data([0x0A])
        lock.lock(); let targets = Array(conns.values); lock.unlock()
        for c in targets { c.send(payload) }
    }
}
