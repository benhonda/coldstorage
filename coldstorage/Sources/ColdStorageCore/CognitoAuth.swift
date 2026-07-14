import Foundation
import AWSCognitoIdentity
import AWSSDKIdentity

/// Bridges Cognito auth into the daemon's AWS credentials — PROD.md Phase 2's credential seam.
/// Single-operator dogfooding never constructs this (`coldstored/main.swift` keeps the default credential
/// chain + the `"blobs"` prefix unless Cognito env vars are present); it exists once the daemon runs for a
/// real signed-in multi-user session.
///
/// `resolver` is built once, unauthenticated, at init — `CognitoAWSCredentialIdentityResolver` makes no
/// network call until something actually needs credentials, so building it eagerly is free and gives
/// `S3Client` a single stable identity to hold onto for the daemon's whole lifetime; `authenticate` swaps
/// its logins in place (`updateLogins`) rather than rebuilding the client. Our identity pool has
/// `allow_unauthenticated_identities = false` (`infra/coldstorage/modules/stack/cognito.tf`), so any S3
/// call attempted before `authenticate` succeeds fails clean on Cognito's own auth error — there is no
/// guest identity it could fall back to.
public actor CognitoAuth {
    public let identityPoolId: String
    public let identityPoolRegion: String
    /// The Cognito User Pool's `Logins` provider key: `cognito-idp.<region>.amazonaws.com/<userPoolId>`
    /// (== `aws_cognito_user_pool.main.endpoint` in Terraform).
    public let userPoolProviderName: String
    /// Handed to `S3Client.S3ClientConfiguration(awsCredentialIdentityResolver:)` at daemon startup.
    public let resolver: CognitoAWSCredentialIdentityResolver
    /// The per-user S3 key prefix (`"blobs/<cognito-identity-id>"`) the IAM role's policy variable
    /// (`blobs/${cognito-identity.amazonaws.com:sub}/*`) matches against. `nil` until `authenticate` succeeds.
    public private(set) var vaultPrefix: String?

    public init(identityPoolId: String, identityPoolRegion: String, userPoolProviderName: String) throws {
        self.identityPoolId = identityPoolId
        self.identityPoolRegion = identityPoolRegion
        self.userPoolProviderName = userPoolProviderName
        self.resolver = try CognitoAWSCredentialIdentityResolver(
            identityPoolId: identityPoolId, identityPoolRegion: identityPoolRegion)
    }

    /// Exchange a Cognito User Pool ID token for Identity Pool credentials. Updates the shared resolver's
    /// logins (so every subsequent S3 call signs as this user) and separately resolves the caller's
    /// identity id via `GetId` — the resolver caches an identity id internally too, but never exposes it,
    /// so we ask Cognito ourselves for the value the vault prefix needs. Idempotent: re-authenticating
    /// (token refresh) keeps the same prefix as long as the underlying identity id is unchanged.
    @discardableResult
    public func authenticate(idToken: String) async throws -> String {
        let logins = [userPoolProviderName: idToken]
        await resolver.updateLogins(logins)
        let client = try CognitoIdentityClient(region: identityPoolRegion)
        let output = try await client.getId(input: GetIdInput(identityPoolId: identityPoolId, logins: logins))
        guard let identityId = output.identityId else {
            throw ColdStorageError.invalidRequest("authenticate: Cognito did not return an identity id")
        }
        vaultPrefix = "blobs/\(identityId)"
        return identityId
    }

    /// Sign-out counterpart: drop the daemon's AWS credentials NOW rather than letting the last STS
    /// creds ride out their ~1h expiry. `updateLogins(nil)` invalidates the resolver's internal
    /// credential + identity-id cache (verified against aws-sdk-swift's
    /// `CognitoAWSCredentialIdentityResolver` source: a logins change calls `cache.invalidate()`), and
    /// the identity pool disallows unauthenticated identities (cognito.tf), so any S3 call after this
    /// fails clean on Cognito's own auth error until the next `authenticate`. Local-only — nothing to
    /// revoke server-side here (the app revokes its Cognito tokens itself).
    public func deauthenticate() async {
        await resolver.updateLogins(nil)
        vaultPrefix = nil
    }
}
