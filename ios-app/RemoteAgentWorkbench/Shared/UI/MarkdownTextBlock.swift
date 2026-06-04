import SwiftUI
import MarkdownUI

struct MarkdownTextBlock: View {
    enum Tone {
        case primary
        case secondary
        case inverse
        case custom(Color)
    }

    private let text: String
    private let tone: Tone
    private let font: Font
    private let allowsSelection: Bool
    private let lineLimit: Int?

    init(
        _ text: String,
        tone: Tone = .primary,
        font: Font = .body,
        allowsSelection: Bool = true,
        lineLimit: Int? = nil
    ) {
        self.text = text
        self.tone = tone
        self.font = font
        self.allowsSelection = allowsSelection
        self.lineLimit = lineLimit
    }

    var body: some View {
        if allowsSelection {
            markdownBody
                .textSelection(.enabled)
        } else {
            markdownBody
                .textSelection(.disabled)
        }
    }

    private var foregroundStyle: Color {
        switch tone {
        case .primary:
            return .primary
        case .secondary:
            return .secondary
        case .inverse:
            return .white.opacity(0.92)
        case .custom(let color):
            return color
        }
    }

    private var markdownBody: some View {
        Markdown(text)
            .font(font)
            .foregroundStyle(foregroundStyle)
            .lineLimit(lineLimit)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }
}
