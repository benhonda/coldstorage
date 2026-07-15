import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// **This process's resident memory, reported by the process itself.**
///
/// It exists because we are otherwise blind. The Core's memory tests run on **Linux**, and the two likeliest
/// reasons a macOS daemon holds memory a Linux one doesn't — Objective-C autorelease pools that never drain
/// inside a long-running async task, and whatever the AWS SDK retains per request — are structurally
/// invisible from there. A 1000-file deposit peaked at **1.7 GB** on a Mac while the same code measured flat
/// under Linux (2026-07-14), and the peak tracked the total bytes uploaded rather than the largest file.
///
/// That is a shape, not a diagnosis, and guessing the mechanism from a Linux container would be a story. The
/// daemon logs its own footprint per part instead, so the next run answers the question with a curve:
/// climbing through the hashing pass points at the scan; a step per part that never comes back down points at
/// per-request retention; flat says the problem is somewhere else entirely.
public enum ProcessMemory {
    /// Resident set size in bytes, or 0 if the platform won't say.
    public static func residentBytes() -> Int {
        #if canImport(Darwin)
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
            }
        }
        return kr == KERN_SUCCESS ? Int(info.resident_size) : 0
        #else
        guard let status = try? String(contentsOfFile: "/proc/self/status", encoding: .utf8) else { return 0 }
        for line in status.split(separator: "\n") where line.hasPrefix("VmRSS:") {
            if let kb = line.split(separator: " ").compactMap({ Int($0) }).first { return kb * 1024 }
        }
        return 0
        #endif
    }

    /// Resident memory as a short human string for a log line — `"412 MB"`.
    public static var resident: String { "\(residentBytes() / 1_048_576) MB" }
}
