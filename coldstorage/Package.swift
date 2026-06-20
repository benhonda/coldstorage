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
                .product(name: "Crypto", package: "swift-crypto"),
                "Csqlite3",
            ]
        ),
        .target(name: "ColdStorageMac", dependencies: ["ColdStorageCore"]),
        .executableTarget(name: "coldstore-cli", dependencies: ["ColdStorageCore"]),
        .executableTarget(name: "coldstore-restore", dependencies: ["ColdStorageCore"]),
        .executableTarget(name: "coldstorectl", dependencies: ["ColdStorageCore"]),
        .executableTarget(name: "coldstored", dependencies: ["ColdStorageCore", "ColdStorageMac"]),
        .testTarget(name: "ColdStorageCoreTests", dependencies: ["ColdStorageCore"]),
    ]
)
