import Foundation
import AWSS3
import Smithy   // ByteStream; if it doesn't resolve in your SDK version, try `import ClientRuntime`
import Crypto

/// Resumable multipart upload of an already-encrypted local blob file to Glacier Deep Archive.
/// NOTE: AWS SDK for Swift `*Input` initializers are generated — field names below are correct,
/// argument ORDER may differ by version; reorder if the compiler objects.
public struct S3Store: Sendable {
    let client: S3Client
    let bucket: String
    let storageClass: S3ClientTypes.StorageClass?   // .deepArchive on real AWS; nil (STANDARD) for MinIO/LocalStack
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

    /// Ranged GET of an object's byte span (a logical file's ciphertext within its blob).
    /// NOTE: real Glacier Deep Archive needs a RestoreObject thaw first; MinIO/STANDARD serves directly.
    public func getRange(key: String, offset: Int, length: Int) async throws -> Data {
        let out = try await client.getObject(input: .init(
            bucket: bucket, key: key, range: "bytes=\(offset)-\(offset + length - 1)"))
        guard let data = try await out.body?.readData() else { throw ColdStorageError.s3("empty body for \(key)") }
        return data
    }
}
