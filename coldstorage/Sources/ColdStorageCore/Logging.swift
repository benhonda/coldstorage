import Foundation

/// One line to the daemon's stderr → `coldstored.err.log` (tailed by `task daemon:mac:logs`). The portable
/// Core has no logger of its own; this is the single SSOT the engine, journal, and daemon all write through
/// so an upload/journal/usage fault is visible at the daemon, not only over the control socket.
func log(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}
