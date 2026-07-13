import Foundation

/// Where one user's blobs live in the vault — and the ONLY way to spell it.
///
/// This exists because a raw `String` prefix is correct for one job and silently wrong for the other,
/// and nothing in the type system said so. The IAM policy scopes a signed-in user's temp credentials with
/// a `s3:prefix` condition of `blobs/${cognito-identity.amazonaws.com:sub}/*`
/// (`infra/coldstorage/modules/stack/cognito.tf`), so:
///
///   - **Building an object key** wants `blobs/<identityId>` + `/` + `<blobId>` — no trailing slash on the
///     namespace, or every key gets a double slash.
///   - **Listing** (`ListObjectsV2`, the storage-quota usage read) wants `blobs/<identityId>/` — WITH the
///     trailing slash, because `blobs/<identityId>` does not match `blobs/<identityId>/*` and AWS answers
///     the request with `AccessDenied` on `s3:ListBucket`.
///
/// Shipping the string un-typed cost us exactly that: usage reads 403'd, `bytesStored` came back `nil`,
/// and the storage-quota gate was silently inert in production. So the slash is settled once, here, by the
/// type — never again at a call site.
///
/// Deliberately NOT loosening the IAM condition to `blobs/<sub>*` to accept the un-slashed form: that
/// pattern would also match a `blobs/<sub>-someone-else/` prefix, weakening the exact cross-user boundary
/// this is all in service of. The client sends a properly delimited prefix; IAM stays strict.
public struct VaultPrefix: Sendable, Equatable, Hashable, CustomStringConvertible {
    /// Canonical namespace, never with a trailing slash. Private so no caller can interpolate it raw.
    private let base: String

    private init(base: String) { self.base = base }

    /// A signed-in user's own prefix. `identityId` is the **Cognito Identity Pool** id (not the user-pool
    /// `sub`) because that is the value AWS substitutes into the IAM policy variable at evaluation time.
    public static func user(identityId: String) -> VaultPrefix { .init(base: "blobs/\(identityId)") }

    /// Local development only (MinIO / no Cognito): the flat legacy namespace. Reachable solely through an
    /// explicit `COLDSTORE_DEV_IDENTITY` — never as a fallback when Cognito config is merely absent. See
    /// `coldstored/main.swift` for why that distinction is load-bearing.
    public static let dev = VaultPrefix(base: "blobs")

    /// The object key for a blob: `<base>/<blobId>`.
    public func key(for blobId: String) -> String { "\(base)/\(blobId)" }

    /// The prefix to hand `ListObjectsV2` — trailing slash included, so the IAM `s3:prefix` condition
    /// matches. See the type doc.
    public var listing: String { "\(base)/" }

    /// The bare namespace, for logs and for asserting on keys in tests. Not for building keys — use
    /// ``key(for:)``.
    public var description: String { base }
}
