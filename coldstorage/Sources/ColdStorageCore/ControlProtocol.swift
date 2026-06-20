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

/// Reply to one request. `result` XOR `error`; nil keys are omitted from the wire JSON.
public struct ControlResponseLine: Encodable, Sendable {
    public let id: Int
    public let result: AnyEncodable?
    public let error: String?
    public init(id: Int, result: AnyEncodable?, error: String?) {
        self.id = id; self.result = result; self.error = error
    }
    private enum K: String, CodingKey { case id, result, error }
    public func encode(to enc: Encoder) throws {
        var c = enc.container(keyedBy: K.self)
        try c.encode(id, forKey: .id)
        if let result { try c.encode(result, forKey: .result) }
        if let error { try c.encode(error, forKey: .error) }
    }
}

/// A server-pushed event (no request id).
struct ControlEventLine: Encodable {
    let event: String
    let data: [String: String]
}
