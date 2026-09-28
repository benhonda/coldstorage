import Foundation

/// A `listFiles` page on the wire, written by hand.
///
/// `JSONEncoder` was most of the 14.8 s a 903,751-row reply took on a real vault (2026-09-27): Codable's
/// generic path does a dynamic cast per value, and a tree that size has ~11M of them. A page is a flat shape
/// of strings and integers, so it goes straight into bytes. A row carries only what the app reads — `id`
/// only when it differs from `relativePath` (it IS the path for any row not moved since it landed), a nil
/// field not at all, `sourcePath` only on a failed row (Try again / Locate… key off it; nothing else reads
/// it), and no `blobId` (nothing reads it). `protocol.ts` (`FilesPage`, `ListedFile`) is the other half.
enum FilesPageJSON {
    /// `revision`: the tree revision the app holds once it has applied this page.
    static func encode(_ page: Journal.FilesPage, revision: Int) -> Data {
        var w = JSONBytes(capacity: 64 + page.files.count * 256 + page.removed.count * 128)
        w.raw("{\"revision\":"); w.int(revision)
        w.raw(",\"cursor\":"); w.string("\(page.cursor.rev).\(page.cursor.rowid)")
        w.raw(",\"more\":"); w.raw(page.more ? "true" : "false")
        w.raw(",\"head\":"); w.int(page.head)
        w.raw(",\"files\":[")
        for (i, f) in page.files.enumerated() {
            if i > 0 { w.raw(",") }
            w.raw("{\"relativePath\":"); w.string(f.relativePath)
            if f.id != f.relativePath { w.raw(",\"id\":"); w.string(f.id) }
            w.raw(",\"size\":"); w.int(f.size)
            w.raw(",\"status\":"); w.string(f.status.rawValue)
            if let v = f.depositId { w.raw(",\"depositId\":"); w.string(v) }
            if let v = f.modifiedAt { w.raw(",\"modifiedAt\":"); w.int(v) }
            if let v = f.createdAt { w.raw(",\"createdAt\":"); w.int(v) }
            if let v = f.lastAttemptAt { w.raw(",\"lastAttemptAt\":"); w.int(v) }
            if let v = f.error { w.raw(",\"error\":"); w.string(v) }
            if let v = f.failureKind { w.raw(",\"failureKind\":"); w.string(v.rawValue) }
            if f.status == .failed, let v = f.sourcePath { w.raw(",\"sourcePath\":"); w.string(v) }
            w.raw("}")
        }
        w.raw("],\"removed\":[")
        for (i, id) in page.removed.enumerated() {
            if i > 0 { w.raw(",") }
            w.string(id)
        }
        w.raw("]}")
        return Data(w.bytes)
    }
}

/// Just enough JSON writer for `FilesPageJSON`: integers, and RFC 8259 strings — quote, backslash and control
/// characters escaped (a macOS filename may hold a newline or a tab), everything else passed through as UTF-8.
struct JSONBytes {
    private(set) var bytes: [UInt8] = []
    init(capacity: Int) { bytes.reserveCapacity(capacity) }

    mutating func raw(_ s: StaticString) { s.withUTF8Buffer { bytes.append(contentsOf: $0) } }
    mutating func int(_ n: Int) { bytes.append(contentsOf: String(n).utf8) }
    mutating func string(_ s: String) {
        bytes.append(0x22)
        for b in s.utf8 {
            switch b {
            case 0x22: bytes.append(0x5C); bytes.append(0x22)
            case 0x5C: bytes.append(0x5C); bytes.append(0x5C)
            case 0x0A: bytes.append(0x5C); bytes.append(0x6E)
            case 0x0D: bytes.append(0x5C); bytes.append(0x72)
            case 0x09: bytes.append(0x5C); bytes.append(0x74)
            case 0x00..<0x20:
                let hex = Array("0123456789abcdef".utf8)
                bytes.append(contentsOf: [0x5C, 0x75, 0x30, 0x30, hex[Int(b >> 4)], hex[Int(b & 0x0F)]])
            default: bytes.append(b)
            }
        }
        bytes.append(0x22)
    }
}
