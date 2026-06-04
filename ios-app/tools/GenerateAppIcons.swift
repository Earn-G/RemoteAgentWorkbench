import AppKit
import Foundation

private let canvasSize: CGFloat = 1024

private struct IconSlot {
    let idiom: String
    let size: String
    let scale: String
    let filename: String
    let pixelSize: Int
}

private let iosSlots: [IconSlot] = [
    .init(idiom: "iphone", size: "20x20", scale: "2x", filename: "Icon-iphone-20@2x.png", pixelSize: 40),
    .init(idiom: "iphone", size: "20x20", scale: "3x", filename: "Icon-iphone-20@3x.png", pixelSize: 60),
    .init(idiom: "iphone", size: "29x29", scale: "2x", filename: "Icon-iphone-29@2x.png", pixelSize: 58),
    .init(idiom: "iphone", size: "29x29", scale: "3x", filename: "Icon-iphone-29@3x.png", pixelSize: 87),
    .init(idiom: "iphone", size: "40x40", scale: "2x", filename: "Icon-iphone-40@2x.png", pixelSize: 80),
    .init(idiom: "iphone", size: "40x40", scale: "3x", filename: "Icon-iphone-40@3x.png", pixelSize: 120),
    .init(idiom: "iphone", size: "60x60", scale: "2x", filename: "Icon-iphone-60@2x.png", pixelSize: 120),
    .init(idiom: "iphone", size: "60x60", scale: "3x", filename: "Icon-iphone-60@3x.png", pixelSize: 180),
    .init(idiom: "ipad", size: "20x20", scale: "1x", filename: "Icon-ipad-20@1x.png", pixelSize: 20),
    .init(idiom: "ipad", size: "20x20", scale: "2x", filename: "Icon-ipad-20@2x.png", pixelSize: 40),
    .init(idiom: "ipad", size: "29x29", scale: "1x", filename: "Icon-ipad-29@1x.png", pixelSize: 29),
    .init(idiom: "ipad", size: "29x29", scale: "2x", filename: "Icon-ipad-29@2x.png", pixelSize: 58),
    .init(idiom: "ipad", size: "40x40", scale: "1x", filename: "Icon-ipad-40@1x.png", pixelSize: 40),
    .init(idiom: "ipad", size: "40x40", scale: "2x", filename: "Icon-ipad-40@2x.png", pixelSize: 80),
    .init(idiom: "ipad", size: "76x76", scale: "1x", filename: "Icon-ipad-76@1x.png", pixelSize: 76),
    .init(idiom: "ipad", size: "76x76", scale: "2x", filename: "Icon-ipad-76@2x.png", pixelSize: 152),
    .init(idiom: "ipad", size: "83.5x83.5", scale: "2x", filename: "Icon-ipad-83_5@2x.png", pixelSize: 167),
    .init(idiom: "ios-marketing", size: "1024x1024", scale: "1x", filename: "Icon-ios-marketing-1024.png", pixelSize: 1024),
]

private let macSlots: [IconSlot] = [
    .init(idiom: "mac", size: "16x16", scale: "1x", filename: "Icon-mac-16@1x.png", pixelSize: 16),
    .init(idiom: "mac", size: "16x16", scale: "2x", filename: "Icon-mac-16@2x.png", pixelSize: 32),
    .init(idiom: "mac", size: "32x32", scale: "1x", filename: "Icon-mac-32@1x.png", pixelSize: 32),
    .init(idiom: "mac", size: "32x32", scale: "2x", filename: "Icon-mac-32@2x.png", pixelSize: 64),
    .init(idiom: "mac", size: "128x128", scale: "1x", filename: "Icon-mac-128@1x.png", pixelSize: 128),
    .init(idiom: "mac", size: "128x128", scale: "2x", filename: "Icon-mac-128@2x.png", pixelSize: 256),
    .init(idiom: "mac", size: "256x256", scale: "1x", filename: "Icon-mac-256@1x.png", pixelSize: 256),
    .init(idiom: "mac", size: "256x256", scale: "2x", filename: "Icon-mac-256@2x.png", pixelSize: 512),
    .init(idiom: "mac", size: "512x512", scale: "1x", filename: "Icon-mac-512@1x.png", pixelSize: 512),
    .init(idiom: "mac", size: "512x512", scale: "2x", filename: "Icon-mac-512@2x.png", pixelSize: 1024),
]

private enum IconError: Error {
    case bitmapCreationFailed(Int)
    case pngEncodingFailed(Int)
}

private func color(_ hex: Int, alpha: CGFloat = 1) -> NSColor {
    NSColor(
        srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
        green: CGFloat((hex >> 8) & 0xFF) / 255,
        blue: CGFloat(hex & 0xFF) / 255,
        alpha: alpha
    )
}

private func withShadow(
    color: NSColor,
    blur: CGFloat,
    offsetX: CGFloat = 0,
    offsetY: CGFloat = 0,
    draw: () -> Void
) {
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = color
    shadow.shadowBlurRadius = blur
    shadow.shadowOffset = NSSize(width: offsetX, height: offsetY)
    shadow.set()
    draw()
    NSGraphicsContext.restoreGraphicsState()
}

private func drawGlow(in rect: NSRect, color: NSColor) {
    let path = NSBezierPath(ovalIn: rect)
    NSGradient(colors: [color, color.withAlphaComponent(0)])?.draw(in: path, relativeCenterPosition: .zero)
}

private func drawSparkle(center: NSPoint, outerRadius: CGFloat, innerRadius: CGFloat, rotation: CGFloat) {
    let path = NSBezierPath()
    let points = 8

    for index in 0..<(points * 2) {
        let angle = rotation + (CGFloat(index) * .pi / CGFloat(points))
        let radius = index.isMultiple(of: 2) ? outerRadius : innerRadius
        let point = NSPoint(
            x: center.x + cos(angle) * radius,
            y: center.y + sin(angle) * radius
        )

        if index == 0 {
            path.move(to: point)
        } else {
            path.line(to: point)
        }
    }

    path.close()
    color(0xF3FFFE, alpha: 0.96).setFill()
    path.fill()

    let core = NSBezierPath(ovalIn: NSRect(x: center.x - 16, y: center.y - 16, width: 32, height: 32))
    color(0x117886, alpha: 0.92).setFill()
    core.fill()
}

private func drawConnector(from start: NSPoint, c1: NSPoint, c2: NSPoint, to end: NSPoint) {
    let path = NSBezierPath()
    path.move(to: start)
    path.curve(to: end, controlPoint1: c1, controlPoint2: c2)
    path.lineCapStyle = .round

    withShadow(color: color(0x39D8DE, alpha: 0.35), blur: 28) {
        path.lineWidth = 50
        color(0x39D8DE, alpha: 0.45).setStroke()
        path.stroke()
    }

    path.lineWidth = 28
    color(0xB9FF78, alpha: 0.94).setStroke()
    path.stroke()
}

private func drawMonitor(in rect: NSRect) {
    withShadow(color: color(0x03090B, alpha: 0.34), blur: 30, offsetY: -10) {
        let shell = NSBezierPath(roundedRect: rect, xRadius: 110, yRadius: 110)
        NSGradient(colors: [
            color(0x102B34, alpha: 0.98),
            color(0x08131A, alpha: 1),
            color(0x0C2230, alpha: 1),
        ])?.draw(in: shell, angle: -38)
        shell.lineWidth = 10
        color(0xDFFCFD, alpha: 0.16).setStroke()
        shell.stroke()
    }

    let sheen = NSBezierPath(roundedRect: rect.insetBy(dx: 28, dy: 28), xRadius: 88, yRadius: 88)
    NSGradient(colors: [
        color(0xB6FFF4, alpha: 0.12),
        color(0xB6FFF4, alpha: 0),
    ])?.draw(in: sheen, angle: 90)

    let headerY = rect.maxY - 86
    let headerLine = NSBezierPath()
    headerLine.move(to: NSPoint(x: rect.minX + 44, y: headerY))
    headerLine.line(to: NSPoint(x: rect.maxX - 44, y: headerY))
    headerLine.lineWidth = 4
    headerLine.lineCapStyle = .round
    color(0xF0FFFF, alpha: 0.12).setStroke()
    headerLine.stroke()

    for (index, dotColor) in [0x39D8DE, 0xB9FF78, 0xF3FFFE].enumerated() {
        let dot = NSBezierPath(ovalIn: NSRect(x: rect.minX + 52 + CGFloat(index) * 28, y: rect.maxY - 68, width: 14, height: 14))
        color(dotColor, alpha: 0.7).setFill()
        dot.fill()
    }

    let chevron = NSBezierPath()
    chevron.move(to: NSPoint(x: rect.minX + 162, y: rect.midY + 90))
    chevron.line(to: NSPoint(x: rect.minX + 284, y: rect.midY))
    chevron.line(to: NSPoint(x: rect.minX + 162, y: rect.midY - 90))
    chevron.lineJoinStyle = .round
    chevron.lineCapStyle = .round
    chevron.lineWidth = 48
    color(0xEFFFFF, alpha: 0.95).setStroke()
    chevron.stroke()

    let cursor = NSBezierPath(roundedRect: NSRect(x: rect.minX + 328, y: rect.midY - 124, width: 150, height: 48), xRadius: 24, yRadius: 24)
    NSGradient(colors: [
        color(0x39D8DE, alpha: 1),
        color(0xB9FF78, alpha: 1),
    ])?.draw(in: cursor, angle: 0)
}

private func drawPhone(in rect: NSRect) {
    withShadow(color: color(0x03090B, alpha: 0.34), blur: 28, offsetY: -8) {
        let body = NSBezierPath(roundedRect: rect, xRadius: 84, yRadius: 84)
        NSGradient(colors: [
            color(0x15313A, alpha: 0.98),
            color(0x0B1720, alpha: 1),
            color(0x123B45, alpha: 1),
        ])?.draw(in: body, angle: -22)
        body.lineWidth = 10
        color(0xDFFCFD, alpha: 0.18).setStroke()
        body.stroke()
    }

    let screen = rect.insetBy(dx: 20, dy: 20)
    let screenPath = NSBezierPath(roundedRect: screen, xRadius: 66, yRadius: 66)
    NSGradient(colors: [
        color(0x0A141B, alpha: 1),
        color(0x0F2831, alpha: 1),
    ])?.draw(in: screenPath, angle: -90)

    let notch = NSBezierPath(roundedRect: NSRect(x: rect.midX - 54, y: rect.maxY - 42, width: 108, height: 16), xRadius: 8, yRadius: 8)
    color(0x051015, alpha: 0.95).setFill()
    notch.fill()

    let activeCard = NSBezierPath(roundedRect: NSRect(x: screen.minX + 28, y: screen.midY + 72, width: screen.width - 56, height: 72), xRadius: 26, yRadius: 26)
    NSGradient(colors: [
        color(0x39D8DE, alpha: 0.95),
        color(0xB9FF78, alpha: 0.95),
    ])?.draw(in: activeCard, angle: 0)

    let secondaryCard = NSBezierPath(roundedRect: NSRect(x: screen.minX + 28, y: screen.midY - 18, width: screen.width - 80, height: 44), xRadius: 22, yRadius: 22)
    color(0xF3FFFE, alpha: 0.18).setFill()
    secondaryCard.fill()

    let tertiaryCard = NSBezierPath(roundedRect: NSRect(x: screen.minX + 28, y: screen.midY - 82, width: screen.width - 120, height: 44), xRadius: 22, yRadius: 22)
    color(0xF3FFFE, alpha: 0.12).setFill()
    tertiaryCard.fill()

    let pulse = NSBezierPath(ovalIn: NSRect(x: screen.midX - 18, y: screen.minY + 48, width: 36, height: 36))
    color(0xB9FF78, alpha: 0.9).setFill()
    pulse.fill()
}

private func drawHub(in rect: NSRect) {
    drawGlow(in: rect.insetBy(dx: -46, dy: -46), color: color(0x39D8DE, alpha: 0.30))

    withShadow(color: color(0x39D8DE, alpha: 0.38), blur: 36) {
        let outerRing = NSBezierPath(ovalIn: rect.insetBy(dx: -18, dy: -18))
        color(0xF3FFFE, alpha: 0.15).setStroke()
        outerRing.lineWidth = 8
        outerRing.stroke()
    }

    let body = NSBezierPath(ovalIn: rect)
    NSGradient(colors: [
        color(0xDBFF78, alpha: 1),
        color(0x39D8DE, alpha: 1),
        color(0x117886, alpha: 1),
    ])?.draw(in: body, relativeCenterPosition: NSPoint(x: -0.2, y: 0.2))

    body.lineWidth = 10
    color(0xF3FFFE, alpha: 0.28).setStroke()
    body.stroke()

    let center = NSPoint(x: rect.midX, y: rect.midY)
    drawSparkle(center: center, outerRadius: 54, innerRadius: 20, rotation: -.pi / 8)
}

private func drawMasterIcon() {
    let canvas = NSRect(x: 0, y: 0, width: canvasSize, height: canvasSize)
    let base = NSBezierPath(rect: canvas)
    NSGradient(colors: [
        color(0x071218, alpha: 1),
        color(0x0A2731, alpha: 1),
        color(0x0C555E, alpha: 1),
    ])?.draw(in: base, angle: -38)

    drawGlow(in: NSRect(x: -80, y: 670, width: 500, height: 420), color: color(0x39D8DE, alpha: 0.22))
    drawGlow(in: NSRect(x: 590, y: -10, width: 440, height: 420), color: color(0xDBFF78, alpha: 0.20))
    drawGlow(in: NSRect(x: 260, y: 210, width: 540, height: 460), color: color(0x39D8DE, alpha: 0.10))

    let monitor = NSRect(x: 348, y: 188, width: 552, height: 492)
    let phone = NSRect(x: 150, y: 294, width: 252, height: 478)
    let hub = NSRect(x: 404, y: 588, width: 184, height: 184)

    drawMonitor(in: monitor)
    drawPhone(in: phone)

    drawConnector(
        from: NSPoint(x: phone.maxX - 10, y: phone.midY + 72),
        c1: NSPoint(x: 446, y: 626),
        c2: NSPoint(x: 446, y: 650),
        to: NSPoint(x: hub.minX + 44, y: hub.midY - 18)
    )
    drawConnector(
        from: NSPoint(x: hub.midX + 44, y: hub.midY - 26),
        c1: NSPoint(x: 612, y: 618),
        c2: NSPoint(x: 560, y: 520),
        to: NSPoint(x: monitor.minX + 86, y: monitor.midY + 42)
    )

    drawHub(in: hub)
}

private func renderPNG(size: Int) throws -> Data {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: size,
        pixelsHigh: size,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        throw IconError.bitmapCreationFailed(size)
    }

    bitmap.size = NSSize(width: size, height: size)

    guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        throw IconError.bitmapCreationFailed(size)
    }

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high

    let cg = context.cgContext
    cg.scaleBy(x: CGFloat(size) / canvasSize, y: CGFloat(size) / canvasSize)
    cg.setShouldAntialias(true)
    drawMasterIcon()

    NSGraphicsContext.restoreGraphicsState()

    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        throw IconError.pngEncodingFailed(size)
    }

    return data
}

private func writeJSON(_ object: Any, to url: URL) throws {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: url)
}

private func writeAssetCatalog(at assetCatalogURL: URL, slots: [IconSlot]) throws {
    let fileManager = FileManager.default
    try fileManager.createDirectory(at: assetCatalogURL, withIntermediateDirectories: true)

    let rootContentsURL = assetCatalogURL.deletingLastPathComponent().appendingPathComponent("Contents.json")
    if !fileManager.fileExists(atPath: rootContentsURL.path) {
        try writeJSON([
            "info": [
                "author": "xcode",
                "version": 1,
            ],
        ], to: rootContentsURL)
    }

    var images: [[String: String]] = []

    for slot in slots {
        let data = try renderPNG(size: slot.pixelSize)
        try data.write(to: assetCatalogURL.appendingPathComponent(slot.filename))

        images.append([
            "filename": slot.filename,
            "idiom": slot.idiom,
            "scale": slot.scale,
            "size": slot.size,
        ])
    }

    try writeJSON([
        "images": images,
        "info": [
            "author": "xcode",
            "version": 1,
        ],
    ], to: assetCatalogURL.appendingPathComponent("Contents.json"))
}

private func writePreview(to url: URL) throws {
    let data = try renderPNG(size: 1024)
    try data.write(to: url)
}

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let iosIconURL = root.appendingPathComponent("RemoteAgentWorkbench/Assets.xcassets/AppIcon.appiconset")
let macIconURL = root.appendingPathComponent("RemoteAgentWorkbenchMac/Assets.xcassets/AppIcon.appiconset")
let previewURL = root.appendingPathComponent("AppIcon-preview.png")

do {
    try writeAssetCatalog(at: iosIconURL, slots: iosSlots)
    try writeAssetCatalog(at: macIconURL, slots: macSlots)
    try writePreview(to: previewURL)
    print("Generated app icons:")
    print("  iOS: \(iosIconURL.path)")
    print("  macOS: \(macIconURL.path)")
    print("  Preview: \(previewURL.path)")
} catch {
    fputs("Failed to generate app icons: \(error)\n", stderr)
    exit(1)
}
