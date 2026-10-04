// Reproduce the synthetic OCR fixture on macOS. No screen capture or network.
// swift fixtures/mission/generate-ocr-reference.swift fixtures/mission/ocr-reference.png
import Foundation
import CoreGraphics
import CoreText
import ImageIO

let destination = CommandLine.arguments.dropFirst().first ?? "fixtures/mission/ocr-reference.png"
let width = 1200, height = 300
let colorSpace = CGColorSpaceCreateDeviceRGB()
guard let context = CGContext(data: nil, width: width, height: height,
                              bitsPerComponent: 8, bytesPerRow: width * 4,
                              space: colorSpace,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    fatalError("Cannot allocate the synthetic fixture bitmap")
}
context.setFillColor(CGColor(gray: 1, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: width, height: height))
for (text, size, y) in [("SECURITIES REVIEW", 54.0, 210.0),
                         ("Revenue grew 18 percent in 2026.", 40.0, 130.0),
                         ("Public filing reference 1042", 36.0, 55.0)] {
    let attributes: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName("Helvetica" as CFString, size, nil),
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0, alpha: 1)
    ]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes))
    context.textPosition = CGPoint(x: 50, y: y)
    CTLineDraw(line, context)
}
guard let image = context.makeImage(),
      let output = CGImageDestinationCreateWithURL(URL(fileURLWithPath: destination) as CFURL, "public.png" as CFString, 1, nil) else {
    fatalError("Cannot create the synthetic fixture PNG")
}
CGImageDestinationAddImage(output, image, nil)
guard CGImageDestinationFinalize(output) else { fatalError("Cannot save the synthetic fixture PNG") }
print("Wrote synthetic OCR fixture: \(width)x\(height)")
