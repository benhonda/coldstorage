// swift-tools-version: 6.0
import PackageDescription

// Phase 0 spike #2: can a launchd-style signed binary hold a durable Photos grant
// and read a FULL-RES ORIGINAL (incl. the iCloud-download path)?
// `Photos` is a system framework — no package dependency needed; it links on import.
let package = Package(
    name: "photos-spike",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "photos-spike")
    ]
)
