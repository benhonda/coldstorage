import Foundation
#if canImport(Glibc)
import Glibc
let csSockStream = Int32(SOCK_STREAM.rawValue)   // Glibc types SOCK_* as an enum
#elseif canImport(Darwin)
import Darwin
let csSockStream = SOCK_STREAM
#endif

/// POSIX unix-domain socket helpers shared by `ControlServer` (bind/listen) and `ControlClient`
/// (connect). Kept in Core because the socket transport is portable (Linux + macOS) — only FSEvents
/// is genuinely Apple-only. The fiddly bit is poking the path into `sockaddr_un.sun_path` (a C
/// fixed-size tuple) — done once here.
enum UnixSocket {
    /// Open a SOCK_STREAM unix socket; throws on too-long paths or syscall failure.
    static func openSocket() throws -> Int32 {
        let fd = socket(AF_UNIX, csSockStream, 0)
        guard fd >= 0 else { throw ColdStorageError.staging("socket(): errno \(errno)") }
        return fd
    }

    /// Fill a `sockaddr_un` for `path`; returns it plus the byte length to pass to bind/connect.
    static func address(_ path: String) throws -> (addr: sockaddr_un, len: socklen_t) {
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        let cap = MemoryLayout.size(ofValue: addr.sun_path)
        guard bytes.count < cap else { throw ColdStorageError.staging("socket path too long (\(bytes.count) ≥ \(cap)): \(path)") }
        withUnsafeMutablePointer(to: &addr.sun_path) {
            $0.withMemoryRebound(to: CChar.self, capacity: cap) { dst in
                for (i, b) in bytes.enumerated() { dst[i] = CChar(bitPattern: b) }
                dst[bytes.count] = 0
            }
        }
        return (addr, socklen_t(MemoryLayout<sockaddr_un>.size))
    }

    /// Set a receive timeout (SO_RCVTIMEO) so a stalled/silent peer surfaces as a read error instead of
    /// an unbounded block. `read()` then returns -1/EAGAIN once `seconds` elapse with no data.
    static func setReadTimeout(_ fd: Int32, seconds: TimeInterval) {
        var tv = timeval()
        tv.tv_sec = .init(seconds)                                   // truncates to whole seconds
        tv.tv_usec = .init((seconds - seconds.rounded(.down)) * 1_000_000)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    }

    /// Write all bytes, looping past partial writes. Returns false if the peer is gone.
    @discardableResult
    static func writeAll(_ fd: Int32, _ data: Data) -> Bool {
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Bool in
            guard let base = raw.baseAddress else { return true }
            var off = 0
            while off < raw.count {
                let n = write(fd, base.advanced(by: off), raw.count - off)
                if n <= 0 { return false }
                off += n
            }
            return true
        }
    }
}
