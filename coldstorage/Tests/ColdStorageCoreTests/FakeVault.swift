import Foundation
@testable import ColdStorageCore

/// **The one test double for the object store.** There were seven, in seven files — four of them
/// copy-paste `RecordingStore`s differing only in which detail they happened to record. Every new engine
/// test grew an eighth, and a change to the `Vault` protocol meant editing all of them (PILLAR3).
///
/// One fake, configurable along the axes tests actually vary:
///   - **records** what it was asked to do (`createdKeys`, `uploadedPartNumbers`) — so "it did NOT re-upload"
///     and "it reused the open multipart upload" are provable, not assumed;
///   - **behaves like S3**: assembles the parts into an object and serves ranged reads out of it, which is
///     what lets an archive→restore round trip be a real round trip rather than two mocks agreeing;
///   - `alreadyOnS3` — the parts a killed run already landed, for resume;
///   - `failKeys` — inject a permanent upload fault, for per-blob fault isolation;
///   - `retainParts` — **off** for the memory tests: a fake that keeps every part holds the whole blob in
///     RAM itself, which would swamp the very measurement those tests exist to take.
final class FakeVault: Vault, @unchecked Sendable {
    private let lock = NSLock()
    private var _created: [String] = []
    private var _parts: [String: [Int: Data]] = [:]
    private var _objects: [String: Data] = [:]
    private var _completed: Set<String> = []

    /// Keys whose `uploadPart` throws — a blob that can never succeed (`InvalidStorageClass` and friends).
    let failKeys: Set<String>
    /// Parts S3 already holds for a resumed blob: the engine must generate their bytes but not re-send them.
    let alreadyOnS3: Set<Int>
    /// Keep the uploaded bytes? Off when a test is measuring the engine's OWN memory.
    let retainParts: Bool
    /// Hold each `uploadPart` this long, so uploads genuinely overlap in flight — the knob the concurrency
    /// and run-overlap tests need. 0 = instant (the default; parts drain before the next dispatches).
    let delayMs: Int

    private var _current = 0
    /// High-water mark of concurrent `uploadPart` calls — how the concurrency tests prove parallelism is real
    /// and stays within the cap, without timing.
    private(set) var maxConcurrentParts = 0

    init(failKeys: Set<String> = [], alreadyOnS3: Set<Int> = [], retainParts: Bool = true, delayMs: Int = 0) {
        self.failKeys = failKeys; self.alreadyOnS3 = alreadyOnS3
        self.retainParts = retainParts; self.delayMs = delayMs
    }

    // What the store was ASKED to do.
    var createdKeys: [String] { lock.withLock { _created } }
    var uploadedPartNumbers: [Int] { lock.withLock { _parts.values.flatMap(\.keys).sorted() } }
    var completedKeys: [String] { lock.withLock { _completed.sorted() } }
    /// Every byte it was handed, blob by blob and part by part in order — what S3 would have assembled.
    var uploaded: Data {
        lock.withLock {
            _parts.keys.sorted().reduce(Data()) { acc, key in
                let byNumber = _parts[key]!
                return byNumber.keys.sorted().reduce(acc) { $0 + byNumber[$1]! }
            }
        }
    }

    // MARK: BlobStore — the upload half
    func createUpload(key: String) async throws -> String { lock.withLock { _created.append(key) }; return "upload-\(key)" }
    func existingParts(key: String, uploadId: String) async throws -> Set<Int> { alreadyOnS3 }
    func uploadPart(key: String, uploadId: String, number: Int, data: Data) async throws -> (etag: String, sha: String) {
        if failKeys.contains(key) { throw ColdStorageError.s3("InvalidStorageClass (simulated permanent)") }
        lock.withLock { _current += 1; maxConcurrentParts = max(maxConcurrentParts, _current) }
        if delayMs > 0 { try await Task.sleep(for: .milliseconds(delayMs)) }
        lock.withLock {
            _current -= 1
            if retainParts { _parts[key, default: [:]][number] = data }
        }
        return ("etag-\(number)", "sha-\(number)")
    }
    func complete(key: String, uploadId: String, parts: [PartRow]) async throws {
        lock.withLock {
            _completed.insert(key)
            let byNumber = _parts[key] ?? [:]
            _objects[key] = byNumber.keys.sorted().reduce(Data()) { $0 + byNumber[$1]! }
        }
    }
    func verify(key: String) async throws {
        guard !retainParts || lock.withLock({ _objects[key] != nil }) else { throw ColdStorageError.s3("no such object \(key)") }
    }

    // MARK: VaultStore — the restore half
    func thawState(key: String) async throws -> ThawState { .ready }   // STANDARD: readable, no thaw
    func requestThaw(key: String, days: Int, tier: RestoreTier) async throws {}
    func getRange(key: String, offset: Int, length: Int) async throws -> Data {
        // **S3 has no zero-length range.** `S3Store` builds the header `bytes=<offset>-<offset + length - 1>`,
        // so length 0 asks for `bytes=100-99` — backwards, and rejected with a 416. A fake that happily returns
        // empty data here is *more forgiving than the real thing*, which makes any test of the zero-byte path a
        // facade: it passes whether or not the bug is fixed. Reject it exactly as S3 would.
        guard length > 0 else { throw ColdStorageError.s3("invalid range bytes=\(offset)-\(offset + length - 1)") }
        return try lock.withLock {
            guard let object = _objects[key] else { throw ColdStorageError.s3("no such object \(key)") }
            guard offset >= 0, offset + length <= object.count else {
                throw ColdStorageError.s3("range \(offset)..<\(offset + length) outside object of \(object.count)")
            }
            return object.subdata(in: offset..<(offset + length))
        }
    }
    func usageBytes(prefix: VaultPrefix) async throws -> Int { lock.withLock { _objects.values.reduce(0) { $0 + $1.count } } }
}
