import Foundation

/// A single user file/photo to archive, plus the metadata that drives ordering + change detection.
public struct IngestItem: Sendable {
    public let id: String                  // stable key (Photos localIdentifier, or relative path)
    public let relativePath: String
    public let size: Int
    public let contentHash: String         // SHA-256 of plaintext — change/dedupe key
    public let createdAt: Date?
    public let isFavorite: Bool
    public let metadata: [String: String]  // EXIF, album, Live-Photo pairing, …
    public let open: @Sendable () -> AsyncThrowingStream<Data, Error>  // plaintext byte stream

    public init(id: String, relativePath: String, size: Int, contentHash: String,
                createdAt: Date?, isFavorite: Bool, metadata: [String: String] = [:],
                open: @escaping @Sendable () -> AsyncThrowingStream<Data, Error>) {
        self.id = id; self.relativePath = relativePath; self.size = size
        self.contentHash = contentHash; self.createdAt = createdAt
        self.isFavorite = isFavorite; self.metadata = metadata; self.open = open
    }
}

/// A group of items that becomes one S3 object. Small files batched; large files solo.
public struct BlobPlan: Sendable {
    public let id: String
    public let items: [IngestItem]
    public init(id: String, items: [IngestItem]) { self.id = id; self.items = items }
    public var s3Key: String { "blobs/\(id)" }
}

public enum FileStatus: String, Codable, Sendable { case discovered, planned, staging, uploading, verifying, archived, failed }
public enum BlobStatus: String, Codable, Sendable { case open, uploading, completed, verified, aborted }
public enum PartStatus: String, Codable, Sendable { case pending, uploaded, verified }

public enum ColdStorageError: Error { case s3(String), integrity(String), staging(String) }
