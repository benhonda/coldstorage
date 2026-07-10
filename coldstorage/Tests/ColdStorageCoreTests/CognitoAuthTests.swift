import Testing
@testable import ColdStorageCore

/// PROD.md Phase 2b: the credential seam itself. `CognitoAWSCredentialIdentityResolver` makes no network
/// call until something needs credentials, so construction is offline-testable; the live exchange (a real
/// ID token → identity id → own-prefix PUT ok / cross-prefix AccessDenied) is Ben's gate once a test user
/// exists (P5) or via a manually-minted token — not reproducible here without hitting AWS.
@Suite struct CognitoAuthTests {
    @Test func startsUnauthenticatedWithNoVaultPrefix() async throws {
        let auth = try CognitoAuth(identityPoolId: "ca-central-1:00000000-0000-0000-0000-000000000000",
                                   identityPoolRegion: "ca-central-1",
                                   userPoolProviderName: "cognito-idp.ca-central-1.amazonaws.com/ca-central-1_test")
        #expect(await auth.vaultPrefix == nil)
    }

    /// The offline-reachable half of `deauthenticate` (sign-out): it must run clean on a
    /// never-authenticated daemon (the app fires it on every signed-out transition, daemon state
    /// unknown) and leave the prefix nil. The authenticated→deauthenticated flip is Ben's live gate
    /// alongside `authenticate`'s (a real token exchange can't run here without AWS).
    @Test func deauthenticateIsSafeWhenNeverAuthenticated() async throws {
        let auth = try CognitoAuth(identityPoolId: "ca-central-1:00000000-0000-0000-0000-000000000000",
                                   identityPoolRegion: "ca-central-1",
                                   userPoolProviderName: "cognito-idp.ca-central-1.amazonaws.com/ca-central-1_test")
        await auth.deauthenticate()
        #expect(await auth.vaultPrefix == nil)
    }
}
