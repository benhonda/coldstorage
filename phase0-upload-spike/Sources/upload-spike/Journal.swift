import Foundation
#if canImport(Glibc)
import Glibc      // rename(2), fsync, errno on Linux
#elseif canImport(Darwin)
import Darwin     // …and on macOS
#endif

enum JournalError: Error { case renameFailed(Int32) }

/// One uploaded part's durable record. In the real daemon this is a row in SQLite/WAL;
/// for the spike a fsync'd JSON file is enough to prove the resume principle.
struct PartRecord: Codable {
    let partNumber: Int
    var eTag: String
    var checksumSHA256: String
}

/// The crash-safe upload journal. The whole point of the spike: this survives a hard kill,
/// so a restart knows exactly what's done and resumes instead of restarting.
struct UploadJournal: Codable {
    let bucket: String
    let key: String
    let fileSize: Int
    let partSize: Int
    var uploadId: String?
    var parts: [PartRecord]

    static let path = "spike-journal.json"

    static func load() -> UploadJournal? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
        return try? JSONDecoder().decode(UploadJournal.self, from: data)
    }

    /// Durable write: temp file → fsync → atomic rename(2). Cross-platform (Linux + macOS);
    /// a crash can't leave a torn journal.
    func save() throws {
        let tmpPath = Self.path + ".tmp"
        let data = try JSONEncoder().encode(self)
        FileManager.default.createFile(atPath: tmpPath, contents: nil)
        let fh = try FileHandle(forWritingTo: URL(fileURLWithPath: tmpPath))
        try fh.write(contentsOf: data)
        fsync(fh.fileDescriptor)   // force bytes to disk BEFORE the rename
        try fh.close()
        guard rename(tmpPath, Self.path) == 0 else {   // atomic on both Linux and macOS
            throw JournalError.renameFailed(errno)
        }
    }

    static func clear() {
        try? FileManager.default.removeItem(atPath: path)
    }
}
