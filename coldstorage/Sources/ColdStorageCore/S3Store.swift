import Foundation
import AWSS3
import AWSClientRuntime   // AWSServiceError.errorCode — to treat "already thawing" as success
import Smithy   // ByteStream; if it doesn't resolve in your SDK version, try `import ClientRuntime`
import Crypto

/// The object-store operations the upload engine depends on — a seam for fault-injection tests and
/// (later) a concurrency-aware wrapper, without coupling the engine to the concrete S3 client.
/// `S3Store` is the production conformer.
public protocol BlobStore: Sendable {
    func createUpload(key: String) async throws -> String
    func existingParts(key: String, uploadId: String) async throws -> Set<Int>
    func uploadPart(key: String, uploadId: String, number: Int, data: Data) async throws -> (etag: String, sha: String)
    func complete(key: String, uploadId: String, parts: [PartRow]) async throws
    func verify(key: String) async throws
    /// Mark a blob as reclaimable. **Tagging, not deleting** — deliberately.
    ///
    /// The daemon holds the user's own credentials on their Mac. Granting it `s3:DeleteObject` would mean
    /// anything that compromises that machine can erase the archive outright — the precise failure this
    /// product exists to prevent, and one no amount of client-side care can mitigate. So the daemon may only
    /// *mark*: it writes the reap tag, and a bucket lifecycle rule (infra, credentials the client never sees)
    /// performs the expiry. The worst a compromised client can do is queue a deletion that is visible in the
    /// object's tags and reversible until the lifecycle sweep runs.
    ///
    /// Reclaims nothing before Deep Archive's 180-day minimum — expiring early still bills it. This stops the
    /// *ongoing* charge and frees the user's quota; it is not a refund.
    func markReclaimable(key: String) async throws
}

/// The other half of the same seam: what the RESTORE path needs (thaw + ranged read), plus the
/// storage-quota usage listing. `BlobStore` had this seam from the start and `RestoreEngine` did not —
/// it took the concrete `S3Store` — which meant anything constructing a session had to stand up a real AWS
/// client, TLS context and all, even for a test that never makes a network call. Now both halves are
/// injectable, and a fake vault is all a session test needs.
public protocol VaultStore: Sendable {
    func thawState(key: String) async throws -> ThawState
    func requestThaw(key: String, days: Int, tier: RestoreTier) async throws
    func getRange(key: String, offset: Int, length: Int) async throws -> Data
    func usageBytes(prefix: VaultPrefix) async throws -> Int
}

/// Both halves — what a `UserSession` needs to serve a user end-to-end. `S3Store` is the production
/// conformer of both.
public typealias Vault = BlobStore & VaultStore

/// Resumable multipart upload of an already-encrypted local blob file to Glacier Deep Archive.
/// NOTE: AWS SDK for Swift `*Input` initializers are generated — field names below are correct,
/// argument ORDER may differ by version; reorder if the compiler objects.
public struct S3Store: Vault {
    let client: S3Client
    let bucket: String
    let storageClass: S3ClientTypes.StorageClass?   // .deepArchive in prod; nil (STANDARD) leaves it to the bucket
    public static let partSize = 64 << 20   // 64 MiB

    public init(client: S3Client, bucket: String, storageClass: S3ClientTypes.StorageClass? = .deepArchive) {
        self.client = client; self.bucket = bucket; self.storageClass = storageClass
    }

    public func createUpload(key: String) async throws -> String {
        let out = try await client.createMultipartUpload(input: .init(
            bucket: bucket, checksumAlgorithm: .sha256, key: key, storageClass: storageClass))
        guard let id = out.uploadId else { throw ColdStorageError.s3("createMultipartUpload returned no uploadId") }
        return id
    }

    /// Part numbers already on S3 (truth) — the crash-window closer for resume.
    public func existingParts(key: String, uploadId: String) async throws -> Set<Int> {
        let out = try await client.listParts(input: .init(bucket: bucket, key: key, uploadId: uploadId))
        return Set((out.parts ?? []).compactMap { $0.partNumber })
    }

    public func uploadPart(key: String, uploadId: String, number: Int, data: Data) async throws -> (etag: String, sha: String) {
        let sha = Data(SHA256.hash(data: data)).base64EncodedString()
        let out = try await client.uploadPart(input: .init(
            body: .data(data), bucket: bucket, checksumSHA256: sha,
            contentLength: data.count, key: key, partNumber: number, uploadId: uploadId))
        return (out.eTag ?? "", sha)
    }

    public func complete(key: String, uploadId: String, parts: [PartRow]) async throws {
        let completed = parts.sorted { $0.partNumber < $1.partNumber }.map {
            S3ClientTypes.CompletedPart(checksumSHA256: $0.sha256, eTag: $0.eTag, partNumber: $0.partNumber)
        }
        _ = try await client.completeMultipartUpload(input: .init(
            bucket: bucket, key: key, multipartUpload: .init(parts: completed), uploadId: uploadId))
    }

    /// "Archived" means verified-present, not "PUT 200".
    public func verify(key: String) async throws { _ = try await client.headObject(input: .init(bucket: bucket, key: key)) }

    /// The tag the bucket's lifecycle rule filters on (`infra/coldstorage/modules/stack/s3.tf`). One SSOT for
    /// the spelling — a typo here is silent: the object is tagged, the rule never matches, and the bytes bill
    /// forever while the journal believes they're gone.
    public static let reapTagKey = "coldstorage-reap"
    public static let reapTagValue = "true"

    /// `PutObjectTagging` is a metadata write — it does NOT read the object body, so it works on a Deep
    /// Archive object without a thaw. That's the property this whole design rests on: it's the only mutation
    /// a client can make to cold data cheaply, which is why reclamation is expressed as a tag.
    public func markReclaimable(key: String) async throws {
        _ = try await client.putObjectTagging(input: .init(
            bucket: bucket, key: key,
            tagging: .init(tagSet: [.init(key: Self.reapTagKey, value: Self.reapTagValue)])))
    }

    /// Sums `Size` (ciphertext bytes, as actually billed/stored) across every object under `prefix` —
    /// storage-quota enforcement's source of truth. Deliberately NOT the local journal: the journal is
    /// per-device, so it would undercount a user signed in on more than one device. S3, scoped to the
    /// caller's own identity prefix, is the one thing already shared across any number of devices for
    /// that identity. Paginated (`ListObjectsV2` returns ≤1,000 keys/call); a LIST call needs no Deep
    /// Archive thaw, so this is cheap even for a large vault.
    ///
    /// Takes a ``VaultPrefix``, not a `String`, and lists on `prefix.listing` — the TRAILING-SLASH form.
    /// The IAM grant for `s3:ListBucket` is conditioned on `s3:prefix` matching `blobs/<sub>/*`, which the
    /// bare `blobs/<sub>` does not satisfy; passing it un-slashed earns an `AccessDenied` and silently
    /// nils out the quota gate. That happened. The type now makes it unsayable.
    public func usageBytes(prefix: VaultPrefix) async throws -> Int {
        var total = 0
        var token: String? = nil
        repeat {
            let out = try await client.listObjectsV2(input: .init(
                bucket: bucket, continuationToken: token, prefix: prefix.listing))
            total += (out.contents ?? []).reduce(0) { $0 + ($1.size ?? 0) }
            token = (out.isTruncated == true) ? out.nextContinuationToken : nil
        } while token != nil
        return total
    }

    /// Ranged GET of an object's byte span (a logical file's ciphertext within its blob).
    /// Assumes the object is downloadable now — Deep Archive callers must `thawState`/`requestThaw` first
    /// (RestoreEngine orchestrates this); STANDARD/GLACIER_IR serve directly.
    public func getRange(key: String, offset: Int, length: Int) async throws -> Data {
        let out = try await client.getObject(input: .init(
            bucket: bucket, key: key, range: "bytes=\(offset)-\(offset + length - 1)"))
        guard let data = try await out.body?.readData() else { throw ColdStorageError.s3("empty body for \(key)") }
        return data
    }

    // MARK: - Glacier thaw (Deep Archive restore-before-GET)

    /// Whether `key` can be ranged-GET right now, per its (server-reported) storage class + restore header.
    /// Reads truth from S3 rather than our upload-time config, so it's correct regardless of how we stored it.
    public func thawState(key: String) async throws -> ThawState {
        let out = try await client.headObject(input: .init(bucket: bucket, key: key))
        return ThawState.from(storageClassRaw: out.storageClass?.rawValue, restoreHeader: out.restore)
    }

    /// Initiate a Glacier retrieval ("thaw") — a temporary `days`-day downloadable copy at `tier` speed.
    /// Idempotent: a concurrent duplicate yields 409 RestoreAlreadyInProgress, which we treat as success.
    public func requestThaw(key: String, days: Int, tier: RestoreTier) async throws {
        do {
            _ = try await client.restoreObject(input: .init(
                bucket: bucket, key: key,
                restoreRequest: .init(days: days, glacierJobParameters: .init(tier: tier.s3Tier))))
        } catch let e as AWSServiceError where e.errorCode == "RestoreAlreadyInProgress" {
            return   // already thawing — nothing to do
        }
    }
}

private extension RestoreTier {
    var s3Tier: S3ClientTypes.Tier {
        switch self { case .expedited: .expedited; case .standard: .standard; case .bulk: .bulk }
    }
}
