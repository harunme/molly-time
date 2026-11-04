// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MollyCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "MollyCore", targets: ["MollyCore"])],
    targets: [
        .target(name: "MollyCore"),
        .testTarget(name: "MollyCoreTests", dependencies: ["MollyCore"])
    ]
)
