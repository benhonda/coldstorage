import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
// Glibc's Swift module doesn't surface <sys/xattr.h>; bind the three calls we need by symbol. The `l`
// variants act on the path itself (no symlink following) — the same as Darwin's `XATTR_NOFOLLOW`.
@_silgen_name("llistxattr") private func llistxattr(_ path: UnsafePointer<CChar>, _ list: UnsafeMutablePointer<CChar>?, _ size: Int) -> Int
@_silgen_name("lgetxattr") private func lgetxattr(_ path: UnsafePointer<CChar>, _ name: UnsafePointer<CChar>, _ value: UnsafeMutableRawPointer?, _ size: Int) -> Int
@_silgen_name("lsetxattr") private func lsetxattr(_ path: UnsafePointer<CChar>, _ name: UnsafePointer<CChar>, _ value: UnsafeRawPointer?, _ size: Int, _ flags: Int32) -> Int32
#endif

/// **What a file IS, beyond its bytes** — the part of a backup that used to be silently thrown away.
///
/// Captured at ingest (`capture(at:)`), stored on the journal row (`files.metadata`, JSON) AND inside the
/// encrypted blob (`BlobManifest`), and written back onto the restored file (`apply(to:)`). Every field is
/// optional: a source that can't know one (a Photos asset has no POSIX mode; Linux has no BSD flags) leaves
/// it nil, and `apply` skips what it doesn't have rather than inventing a value.
///
/// Deliberately NOT captured: owner/group (meaningless on another Mac), access time (noise), ACLs
/// (machine-bound, and macOS refuses to set them back anyway), and the xattrs in `droppedXattrs`.
public struct FileMetadata: Codable, Sendable, Equatable {
    /// Last-modified time (Unix seconds). For a local file, its mtime; nil for a Photos asset.
    public var modifiedAt: Int?
    /// Creation time (Unix seconds) — the filesystem birth time for a local file, the CAPTURE date for a
    /// Photos asset (which is what a person means by "when was this created" for a photo).
    public var createdAt: Int?
    /// POSIX permission bits (`st_mode & 0o7777`) — what keeps a restored script executable.
    public var mode: UInt16?
    /// BSD file flags worth restoring (`UF_HIDDEN`, `UF_IMMUTABLE` — "hidden" and "locked" in Finder's
    /// Get Info). macOS only; nil where the platform has none.
    public var flags: UInt32?
    /// Extended attributes, raw — Finder tags (`com.apple.metadata:_kMDItemUserTags`), Finder comments,
    /// label colours (`com.apple.FinderInfo`), and whatever else an app hung on the file. Base64 on the wire
    /// (JSON `Data`). Empty for a Photos asset.
    public var xattrs: [String: Data]
    /// Photos-only facts (`uti`, `favorite`, …) that have no filesystem home. Nil for a local file.
    public var photo: [String: String]?

    public init(modifiedAt: Int? = nil, createdAt: Int? = nil, mode: UInt16? = nil, flags: UInt32? = nil,
                xattrs: [String: Data] = [:], photo: [String: String]? = nil) {
        self.modifiedAt = modifiedAt; self.createdAt = createdAt; self.mode = mode; self.flags = flags
        self.xattrs = xattrs; self.photo = photo
    }

    /// The local file's date, whichever it has — what the file browser sorts and labels a row by.
    public var date: Int? { modifiedAt ?? createdAt }

    // MARK: - capture

    /// Extended attributes that must NOT follow a file into the archive: they describe this Mac's
    /// relationship to the file, not the file. `quarantine` coming back would make every restored download
    /// re-prompt Gatekeeper; `macl`/`provenance` are per-machine app-sandbox bookkeeping that macOS refuses
    /// to accept from outside; `lastuseddate` is noise; `rootless` is SIP's own marker.
    static let droppedXattrs: Set<String> = [
        "com.apple.quarantine", "com.apple.macl", "com.apple.provenance",
        "com.apple.lastuseddate#PS", "com.apple.rootless",
    ]
    /// A single xattr larger than this (a custom icon's resource fork can be megabytes) is left behind —
    /// the manifest rides in every blob, and one oversized attribute shouldn't dwarf the file it describes.
    static let maxXattrBytes = 256 * 1024
    /// Flags worth carrying: the two a person sets on purpose (Get Info › Hidden / Locked). Everything
    /// else in `st_flags` is system bookkeeping (`SF_*`, `UF_COMPRESSED`, `UF_TRACKED`) that must not be
    /// written back.
    #if canImport(Darwin)
    static let carriedFlags: UInt32 = UInt32(UF_HIDDEN) | UInt32(UF_IMMUTABLE)
    #endif

    /// Read the file's metadata without following symlinks. Best-effort by design: a stat or xattr read
    /// that fails leaves that field nil rather than failing the ingest — metadata is never a reason not
    /// to back the bytes up.
    public static func capture(at url: URL) -> FileMetadata {
        var m = FileMetadata()
        if let attrs = try? FileManager.default.attributesOfItem(atPath: url.path) {
            m.modifiedAt = (attrs[.modificationDate] as? Date).map { Int($0.timeIntervalSince1970) }
            m.createdAt = (attrs[.creationDate] as? Date).map { Int($0.timeIntervalSince1970) }
            m.mode = (attrs[.posixPermissions] as? Int).map { UInt16($0 & 0o7777) }
        }
        #if canImport(Darwin)
        var st = stat()
        if lstat(url.path, &st) == 0 {
            let flags = UInt32(st.st_flags) & carriedFlags
            m.flags = flags == 0 ? nil : flags
        }
        #endif
        m.xattrs = readXattrs(url.path)
        return m
    }

    private static func readXattrs(_ path: String) -> [String: Data] {
        #if canImport(Darwin)
        let listSize = listxattr(path, nil, 0, XATTR_NOFOLLOW)
        #else
        let listSize = llistxattr(path, nil, 0)
        #endif
        guard listSize > 0 else { return [:] }
        var names = [CChar](repeating: 0, count: listSize)
        #if canImport(Darwin)
        let got = listxattr(path, &names, listSize, XATTR_NOFOLLOW)
        #else
        let got = llistxattr(path, &names, listSize)
        #endif
        guard got > 0 else { return [:] }
        var out: [String: Data] = [:]
        // The list is NUL-separated names, back to back.
        for name in names[0..<got].split(separator: 0).map({ String(decoding: $0.map { UInt8(bitPattern: $0) }, as: UTF8.self) }) {
            guard !droppedXattrs.contains(name) else { continue }
            #if canImport(Darwin)
            let size = getxattr(path, name, nil, 0, 0, XATTR_NOFOLLOW)
            #else
            let size = lgetxattr(path, name, nil, 0)
            #endif
            guard size >= 0, size <= maxXattrBytes else { continue }
            var buf = [UInt8](repeating: 0, count: size)
            #if canImport(Darwin)
            let n = getxattr(path, name, &buf, size, 0, XATTR_NOFOLLOW)
            #else
            let n = lgetxattr(path, name, &buf, size)
            #endif
            guard n >= 0 else { continue }
            out[name] = Data(buf[0..<n])
        }
        return out
    }

    // MARK: - apply

    /// Write this metadata onto a file that already holds the verified bytes. Best-effort, and returns
    /// what it COULDN'T do (one line each) rather than throwing: the bytes are back and correct, and a tag
    /// that wouldn't stick must not turn a successful restore into a failed one. The caller logs the list.
    ///
    /// Order matters: xattrs and permissions first, dates second (writing an xattr bumps ctime, not mtime,
    /// but keep the dates last so nothing can disturb them), and `UF_IMMUTABLE` very last — once a file is
    /// locked, nothing else here would be allowed to touch it.
    @discardableResult
    public func apply(to url: URL) -> [String] {
        var problems: [String] = []
        let path = url.path
        for (name, value) in xattrs.sorted(by: { $0.key < $1.key }) {
            let rc = value.withUnsafeBytes { raw -> Int32 in
                #if canImport(Darwin)
                setxattr(path, name, raw.baseAddress, value.count, 0, XATTR_NOFOLLOW)
                #else
                lsetxattr(path, name, raw.baseAddress, value.count, 0)
                #endif
            }
            if rc != 0 { problems.append("xattr \(name): \(String(cString: strerror(errno)))") }
        }
        var attrs: [FileAttributeKey: Any] = [:]
        if let mode { attrs[.posixPermissions] = Int(mode) }
        if let modifiedAt { attrs[.modificationDate] = Date(timeIntervalSince1970: TimeInterval(modifiedAt)) }
        if let createdAt { attrs[.creationDate] = Date(timeIntervalSince1970: TimeInterval(createdAt)) }
        if !attrs.isEmpty {
            do { try FileManager.default.setAttributes(attrs, ofItemAtPath: path) }
            catch { problems.append("dates/permissions: \(error)") }
        }
        #if canImport(Darwin)
        if let flags, flags != 0, chflags(path, flags) != 0 {
            problems.append("flags: \(String(cString: strerror(errno)))")
        }
        #endif
        return problems
    }

    // MARK: - JSON (the journal column)

    /// Deterministic encoding (sorted keys) — the same bytes go into the manifest, which must be
    /// byte-reproducible for a resumed upload to match the parts already on S3.
    static let encoder: JSONEncoder = { let e = JSONEncoder(); e.outputFormatting = [.sortedKeys]; return e }()
    public func json() throws -> String { String(decoding: try Self.encoder.encode(self), as: UTF8.self) }
    public static func from(json: String?) -> FileMetadata? {
        guard let json, let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(FileMetadata.self, from: data)
    }
}
