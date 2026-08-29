import Foundation
import Crypto

/// **Every blob describes itself.** Appended to the end of each S3 object, after the last file's frames:
/// an encrypted manifest of what's inside (each file's vault path, size, hash, ciphertext span and
/// `FileMetadata`), followed by a small plaintext footer carrying the blob's nonce prefix and its DEK
/// wrapped under the user's KEK.
///
/// Why: until this existed the journal was the ONLY place that knew where a file's bytes sat inside a
/// blob — and the only place that held the key to read them. Lose the journal (a dead Mac, no second
/// device) and every object in the vault was an unlabelled, undecryptable blob. With the trailer, the KEK
/// plus the objects themselves are enough to get everything back: read the footer, unwrap the DEK, open
/// the manifest, range-read the files. A recovery tool that does exactly that can be written against
/// `BlobTrailer.decode` alone.
///
/// Byte layout of an object:
/// ```
/// [file 1 frames][file 2 frames]…[manifest frames][footer body][footer body length: u32 BE]["CSMF"]
/// footer body = version u8 · prefixLen u8 · prefix · wrappedLen u16 BE · wrappedDEK ·
///               manifestLen u32 BE (sealed bytes) · manifestFirstFrame u64 BE
/// ```
/// The manifest is sealed with the blob's own DEK as ordinary frames continuing the frame counter, so it
/// enjoys the same AEAD integrity as the files. File spans are unaffected — the trailer only ever comes
/// AFTER them — which is what let it ship without touching restore's arithmetic. A blob whose every item is
/// empty has no object at all, so no trailer either.
public struct BlobManifest: Codable, Sendable, Equatable {
    public static let currentVersion = 1

    public struct Entry: Codable, Sendable, Equatable {
        public let id: String
        public let relativePath: String
        /// Plaintext byte count.
        public let size: Int
        /// Ciphertext span inside the object, in bytes — the range a restore reads.
        public let offset: Int
        public let length: Int
        /// Frame counter of the span's first frame (nonces are derived from prefix + counter).
        public let firstFrame: Int
        public let sha256: String
        public let metadata: FileMetadata
        public init(id: String, relativePath: String, size: Int, offset: Int, length: Int, firstFrame: Int,
                    sha256: String, metadata: FileMetadata) {
            self.id = id; self.relativePath = relativePath; self.size = size; self.offset = offset
            self.length = length; self.firstFrame = firstFrame; self.sha256 = sha256; self.metadata = metadata
        }
    }

    public let version: Int
    public let blobId: String
    public let files: [Entry]
    public init(blobId: String, files: [Entry]) {
        self.version = Self.currentVersion; self.blobId = blobId; self.files = files
    }
}

public enum BlobTrailer {
    static let magic = Data("CSMF".utf8)
    static let version: UInt8 = 1

    /// The sealed manifest + footer, ready to append to the object. `firstFrame` is the counter the next
    /// frame would have used; the manifest's frames continue from it. Returns the bytes and how many frames
    /// they used (the caller advances its counter by that, so nothing after could ever reuse a nonce).
    public static func encode(_ manifest: BlobManifest, cipher: EnvelopeCipher, dek: SymmetricKey,
                              prefix: Data, firstFrame: UInt64, wrappedDEK: Data) throws -> (bytes: Data, frames: Int) {
        let plain = try FileMetadata.encoder.encode(manifest)   // sorted keys → byte-reproducible
        var sealed = Data()
        var frame = firstFrame
        var cursor = 0
        repeat {
            let end = min(cursor + EnvelopeCipher.frameSize, plain.count)
            sealed.append(try cipher.seal(plain[cursor..<end], dek: dek, prefix: prefix, frame: frame))
            frame += 1; cursor = end
        } while cursor < plain.count
        guard prefix.count <= UInt8.max, wrappedDEK.count <= UInt16.max, sealed.count <= UInt32.max else {
            throw ColdStorageError.integrity("blob trailer: field too large to encode")
        }
        var body = Data([version, UInt8(prefix.count)])
        body.append(prefix)
        body.append(be(UInt16(wrappedDEK.count)))
        body.append(wrappedDEK)
        body.append(be(UInt32(sealed.count)))
        body.append(be(firstFrame))
        var out = sealed
        out.append(body)
        out.append(be(UInt32(body.count)))
        out.append(magic)
        return (out, Int(frame - firstFrame))
    }

    /// What the footer says about a blob, before anything is decrypted — the part a recovery tool reads
    /// off the last few hundred bytes of an object.
    public struct Footer: Sendable, Equatable {
        public let noncePrefix: Data
        public let wrappedDEK: Data
        /// Byte range of the sealed manifest inside the object.
        public let manifestRange: Range<Int>
        public let manifestFirstFrame: UInt64
    }

    /// Parse the footer from the whole object (or from any suffix of it that includes the manifest).
    /// `objectSize` is needed when `tail` is a suffix: ranges are reported in object coordinates.
    public static func footer(of tail: Data, objectSize: Int? = nil) throws -> Footer {
        let total = objectSize ?? tail.count
        let base = total - tail.count   // object offset of tail[0]
        guard tail.count >= 8, tail.suffix(4) == magic else {
            throw ColdStorageError.integrity("blob trailer: no manifest footer (not a ColdStorage object, or an old one)")
        }
        let bodyLen = Int(readBE(UInt32.self, tail, at: tail.count - 8))
        let bodyStart = tail.count - 8 - bodyLen
        guard bodyStart >= 0 else { throw ColdStorageError.integrity("blob trailer: footer length exceeds object") }
        var p = bodyStart
        guard tail[relative: p] == version else { throw ColdStorageError.integrity("blob trailer: unknown version \(tail[relative: p])") }
        p += 1
        let prefixLen = Int(tail[relative: p]); p += 1
        let prefix = tail.subdata(in: (tail.startIndex + p)..<(tail.startIndex + p + prefixLen)); p += prefixLen
        let wrappedLen = Int(readBE(UInt16.self, tail, at: p)); p += 2
        let wrapped = tail.subdata(in: (tail.startIndex + p)..<(tail.startIndex + p + wrappedLen)); p += wrappedLen
        let manifestLen = Int(readBE(UInt32.self, tail, at: p)); p += 4
        let firstFrame = readBE(UInt64.self, tail, at: p)
        let manifestStart = bodyStart - manifestLen
        guard manifestStart >= 0 else { throw ColdStorageError.integrity("blob trailer: manifest extends before the object's start") }
        return Footer(noncePrefix: prefix, wrappedDEK: wrapped,
                      manifestRange: (base + manifestStart)..<(base + bodyStart), manifestFirstFrame: firstFrame)
    }

    /// Everything a recovery needs from one object + the user's KEK: the manifest, decrypted and verified.
    public static func decode(object: Data, kek: SymmetricKey, cipher: EnvelopeCipher = EnvelopeCipher()) throws -> BlobManifest {
        let f = try footer(of: object)
        let dek = try cipher.unwrap(f.wrappedDEK, kek: kek)
        let sealed = object.subdata(in: (object.startIndex + f.manifestRange.lowerBound)..<(object.startIndex + f.manifestRange.upperBound))
        var plain = Data()
        var frame = f.manifestFirstFrame
        var cursor = 0
        while cursor < sealed.count {
            let end = min(cursor + EnvelopeCipher.sealedFrameSize, sealed.count)
            plain.append(try cipher.open(sealed[cursor..<end], dek: dek, prefix: f.noncePrefix, frame: frame))
            frame += 1; cursor = end
        }
        return try JSONDecoder().decode(BlobManifest.self, from: plain)
    }

    private static func be<T: FixedWidthInteger>(_ v: T) -> Data {
        withUnsafeBytes(of: v.bigEndian) { Data($0) }
    }
    private static func readBE<T: FixedWidthInteger>(_: T.Type, _ d: Data, at offset: Int) -> T {
        var v: T = 0
        withUnsafeMutableBytes(of: &v) { dst in
            for i in 0..<MemoryLayout<T>.size { dst[i] = d[relative: offset + i] }
        }
        return T(bigEndian: v)
    }
}

private extension Data {
    /// `Data` slices keep their parent's indices; this reads by position from the slice's own start.
    subscript(relative i: Int) -> UInt8 { self[startIndex + i] }
}
