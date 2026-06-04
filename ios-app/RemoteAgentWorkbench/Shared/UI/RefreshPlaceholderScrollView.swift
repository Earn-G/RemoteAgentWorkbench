import SwiftUI

struct RefreshPlaceholderScrollView<Content: View>: View {
    @ViewBuilder private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack {
                    content
                        .frame(maxWidth: .infinity)
                }
                .frame(minHeight: geometry.size.height)
            }
        }
    }
}
