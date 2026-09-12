// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "tandemise-helper",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(
            name: "tandemise-helper",
            path: "Sources/tandemise-helper",
            // Swift 5 language mode: this process is deliberately single-threaded
            // (all work runs on the main thread, see main.swift) and strict
            // concurrency checking buys nothing while fighting the CF/AX APIs.
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
