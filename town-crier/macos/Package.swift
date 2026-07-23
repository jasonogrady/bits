// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "TownCrier",
    platforms: [.macOS("15.0")], // targets macOS 26+; 15.0 floor so the scaffold builds anywhere recent
    targets: [
        .executableTarget(name: "TownCrier", path: "Sources/TownCrier")
    ]
)
