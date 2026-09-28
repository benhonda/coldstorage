import Foundation

/// Wire contract for the daemon control plane (§9 of the design): a **local unix-domain socket**
/// speaking **newline-delimited JSON**. A client sends one `ControlRequest` per line; the daemon
/// replies with one line per message — either a response (carries the request `id`) or a pushed
/// event (carries `event`). The client distinguishes them by which key is present.

public struct ControlRequest: Codable, Sendable {
    public let id: Int
    public let method: String
    public let params: [String: String]?
    public init(id: Int, method: String, params: [String: String]? = nil) {
        self.id = id; self.method = method; self.params = params
    }
}

/// Type-erased `Encodable` so each command can return its own strongly-typed result while the
/// transport encodes uniformly — no `as any`, no per-method envelope plumbing.
public struct AnyEncodable: Encodable, @unchecked Sendable {
    private let _encode: (Encoder) throws -> Void
    public init<T: Encodable>(_ wrapped: T) { _encode = wrapped.encode }
    public func encode(to encoder: Encoder) throws { try _encode(encoder) }
}

/// Reply to one request: a result XOR `error`; nil keys are omitted from the wire JSON. Not `Encodable` —
/// `encoded()` is the one way onto the wire, so a `resultJSON` can't be silently dropped by a `JSONEncoder`.
public struct ControlResponseLine: Sendable {
    public let id: Int
    public let result: AnyEncodable?
    /// A result that is already JSON, written into the line as-is — for a reply `JSONEncoder` is too slow to
    /// write (a `listFiles` page; see `FilesPageJSON`).
    public let resultJSON: Data?
    public let error: String?
    public init(id: Int, result: AnyEncodable?, error: String?) {
        self.id = id; self.result = result; self.resultJSON = nil; self.error = error
    }
    public init(id: Int, resultJSON: Data) {
        self.id = id; self.result = nil; self.resultJSON = resultJSON; self.error = nil
    }

    /// The line as it goes on the wire, without the newline.
    public func encoded() throws -> Data {
        var line = Data("{\"id\":\(id)".utf8)
        if let resultJSON { line += Data(",\"result\":".utf8) + resultJSON }
        else if let result { line += Data(",\"result\":".utf8) + (try JSONEncoder().encode(result)) }
        if let error { line += Data(",\"error\":".utf8) + (try JSONEncoder().encode(error)) }
        return line + Data("}".utf8)
    }
}

/// A server-pushed event (no request id).
struct ControlEventLine: Encodable {
    let event: String
    let data: [String: String]
}
