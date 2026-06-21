import Foundation
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

/// Thin blocking client for the daemon control socket — used by `coldstorectl` and the tests, and a
/// reference for the eventual Electron control panel. Newline-delimited JSON, one connection.
public final class ControlClient {
    private let fd: Int32

    /// `readTimeout` (seconds) bounds each `readLine()` so a stalled daemon fails fast instead of
    /// hanging forever — nil (default) blocks indefinitely, which is what a live event tail wants.
    public init(path: String, readTimeout: TimeInterval? = nil) throws {
        let f = try UnixSocket.openSocket()
        var (addr, len) = try UnixSocket.address(path)
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(f, $0, len) }
        }
        guard ok == 0 else { close(f); throw ColdStorageError.staging("connect(\(path)): errno \(errno)") }
        if let readTimeout { UnixSocket.setReadTimeout(f, seconds: readTimeout) }
        fd = f
    }

    public func send(_ req: ControlRequest) throws {
        var data = try JSONEncoder().encode(req); data.append(0x0A)
        try sendRaw(data)
    }

    /// Write bytes verbatim (no framing). For tests/diagnostics that need to send a raw line.
    public func sendRaw(_ data: Data) throws {
        guard UnixSocket.writeAll(fd, data) else { throw ColdStorageError.staging("write to control socket failed") }
    }

    /// Read one newline-delimited line (response or pushed event). nil on EOF (or on a read-timeout,
    /// if one was set). Byte-at-a-time — fine for the low-volume control channel.
    public func readLine() -> Data? {
        var buf = Data(); var byte: UInt8 = 0
        while true {
            let n = read(fd, &byte, 1)
            if n <= 0 { return buf.isEmpty ? nil : buf }
            if byte == 0x0A { return buf }
            buf.append(byte)
        }
    }

    public func disconnect() { close(fd) }
}
