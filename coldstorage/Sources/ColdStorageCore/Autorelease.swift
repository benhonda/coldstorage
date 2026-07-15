#if canImport(Darwin)
import Darwin   // `autoreleasepool` comes from the ObjC runtime, via Foundation on Darwin.
#else

/// **`autoreleasepool` on Linux: a passthrough — because there is nothing to drain.**
///
/// Swift on Linux has no Objective-C runtime, so the symbol doesn't exist at all. Rather than litter the
/// engine with `#if canImport(Darwin)` around every read loop, the platform difference is stated once, here.
///
/// It matters that this is a NO-OP and not a mistake. On macOS, `FileHandle.read(upToCount:)` returns
/// Objective-C-backed buffers that are *autoreleased*, and a tight read loop with no pool to drain them
/// accumulates every single one until the enclosing task ends — Apple's own guidance says a FileHandle read
/// loop "won't need an autoreleasepool on Linux but will on macOS". Hashing 2 GB of files left **841 MB
/// resident before a byte was uploaded** (2026-07-14).
///
/// The trap this leaves behind, and the reason for the comment: **the Core's memory tests run on Linux**,
/// where removing the pools changes nothing and every test still passes. A green suite is not evidence that
/// the pools are unnecessary. The daemon's own RSS log (`ProcessMemory`, surfaced by `task
/// daemon:mac:memory`) is the only thing that can see it.
@inline(__always)
func autoreleasepool<Result>(invoking body: () throws -> Result) rethrows -> Result {
    try body()
}

#endif
