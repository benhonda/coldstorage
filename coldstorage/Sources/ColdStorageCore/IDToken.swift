import Foundation

/// The claims we read out of a Cognito **User Pool** ID token. Only `sub` — the stable, per-account user
/// id — which is the canonical answer to "who is signed in" everywhere in this system: the app's key
/// escrow is keyed by it (`ui/src/main/vault/storage.ts`), the account backend authorizes by it, and now
/// the daemon's per-user state directory is named for it.
///
/// **On trust:** this decodes the JWT without verifying its signature, and that is safe *only* in the one
/// place it's used — `DaemonService.authenticate`, immediately AFTER Cognito's `GetId` has accepted the
/// same token. An invalid, expired, or forged token fails `GetId` (the identity pool grants nothing to
/// unauthenticated callers), so by the time we read `sub` here, AWS has already vouched for the token.
/// Do not reach for this anywhere a token has not already been exchanged with Cognito.
enum IDToken {
    /// Extract the `sub` claim from a JWT's payload segment.
    static func sub(of jwt: String) throws -> String {
        let segments = jwt.split(separator: ".")
        guard segments.count == 3 else {
            throw ColdStorageError.staging("idToken is not a JWT (expected 3 dot-separated segments)")
        }
        guard let payload = base64URLDecode(String(segments[1])),
              let claims = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
              let sub = claims["sub"] as? String, !sub.isEmpty else {
            throw ColdStorageError.staging("idToken payload has no 'sub' claim")
        }
        return sub
    }

    /// JWT segments are base64**url** (`-`/`_` for `+`/`/`) and unpadded — `Data(base64Encoded:)` rejects
    /// both, so translate and re-pad to a multiple of 4 before decoding.
    private static func base64URLDecode(_ s: String) -> Data? {
        var b64 = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        b64 += String(repeating: "=", count: (4 - b64.count % 4) % 4)
        return Data(base64Encoded: b64)
    }
}
