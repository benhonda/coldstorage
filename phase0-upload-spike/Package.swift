// swift-tools-version: 6.0
import PackageDescription

// Phase 0 spike: prove journal-backed, kill-resumable S3 multipart upload to Glacier Deep Archive.
// Bump aws-sdk-swift to the latest 1.x tag before running.
let package = Package(
    name: "upload-spike",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/awslabs/aws-sdk-swift", from: "1.0.0"),
        .package(url: "https://github.com/apple/swift-crypto", from: "3.0.0")  // cross-platform SHA-256 (replaces CryptoKit) → runs on Linux too
    ],
    targets: [
        .executableTarget(
            name: "upload-spike",
            dependencies: [
                .product(name: "AWSS3", package: "aws-sdk-swift"),
                .product(name: "Crypto", package: "swift-crypto")
            ]
        )
    ]
)
