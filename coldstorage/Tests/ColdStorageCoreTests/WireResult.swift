import Foundation
@testable import ColdStorageCore

extension ControlResponseLine {
    /// The reply's `result`, parsed off the line exactly as it goes on the wire — what the app is handed,
    /// whichever way the daemon wrote it (`JSONEncoder`, or `FilesPageJSON` for `listFiles`).
    func wireResult() throws -> Any? {
        (try JSONSerialization.jsonObject(with: encoded()) as? [String: Any])?["result"]
    }
}
