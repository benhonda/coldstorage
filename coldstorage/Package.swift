// swift-tools-version: 6.0
import PackageDescription

// ColdStorage daemon. Core is portable (Linux + macOS); the Mac target + daemon hold the
// Apple-only seam. SQLite is the system library directly (no ORM dep) — Linux-clean, full control
// over the journal SPOF. See ../daemon-module-split.md.
let package = Package(
    name: "ColdStorage",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/awslabs/aws-sdk-swift", from: "1.0.0"),
        .package(url: "https://github.com/apple/swift-crypto", from: "3.0.0"),
    ],
    targets: [
        .systemLibrary(
            name: "Csqlite3",
            path: "Sources/Csqlite3",
            providers: [.apt(["libsqlite3-dev"]), .brew(["sqlite3"])]
        ),
        .target(
            name: "ColdStorageCore",
            dependencies: [
                .product(name: "AWSS3", package: "aws-sdk-swift"),
                .product(name: "AWSClientRuntime", package: "aws-sdk-swift"),   // AWSServiceError (thaw idempotency)
                .product(name: "Crypto", package: "swift-crypto"),
                "Csqlite3",
            ]
        ),
        .target(name: "ColdStorageMac", dependencies: ["ColdStorageCore"]),
        .executableTarget(name: "coldstore-cli", dependencies: ["ColdStorageCore"]),
        .executableTarget(name: "coldstore-restore", dependencies: ["ColdStorageCore"]),
        .executableTarget(name: "coldstorectl", dependencies: ["ColdStorageCore"]),
        // The native Photos picker (UI option B). No deps — it just prints selected asset ids as JSON;
        // AppKit/PhotosUI on macOS, a stub that exits 1 elsewhere. The daemon reads the picked originals.
        .executableTarget(name: "coldstore-photo-picker"),
        .executableTarget(
            name: "coldstored", dependencies: ["ColdStorageCore", "ColdStorageMac"],
            // Embed Info.plist into the Mach-O so the unbundled daemon has a TCC identity (required for any
            // Photos read — the explicit photo-deposit path). macOS-only: -sectcreate is a Mach-O/ld64 flag,
            // meaningless on Linux ELF, so the platform condition keeps Linux/CI builds clean. The codesign
            // step (a STABLE identity, which TCC also keys to) lives in `task daemon:install`. See
            // launchd/coldstored-Info.plist + phase0-photos-spike.
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT",
                              "-Xlinker", "__info_plist", "-Xlinker", "launchd/coldstored-Info.plist"],
                             .when(platforms: [.macOS])),
            ]
        ),
        .testTarget(name: "ColdStorageCoreTests", dependencies: ["ColdStorageCore"]),
    ]
)
