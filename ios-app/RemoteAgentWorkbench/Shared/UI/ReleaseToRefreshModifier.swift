import SwiftUI

#if os(iOS)
import UIKit

private struct ReleaseToRefreshModifier: ViewModifier {
    let isRefreshing: Bool
    let action: () -> Void

    func body(content: Content) -> some View {
        content
            .background {
                ReleaseToRefreshObserver(
                    isRefreshing: isRefreshing,
                    onRefresh: action
                )
                .frame(width: 0, height: 0)
            }
    }
}

private struct ReleaseToRefreshObserver: UIViewRepresentable {
    let isRefreshing: Bool
    let onRefresh: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onRefresh: onRefresh)
    }

    func makeUIView(context: Context) -> ReleaseToRefreshProbeView {
        let view = ReleaseToRefreshProbeView()
        view.onLayout = { probe in
            context.coordinator.attachIfNeeded(from: probe)
        }
        return view
    }

    func updateUIView(_ uiView: ReleaseToRefreshProbeView, context: Context) {
        context.coordinator.onRefresh = onRefresh
        context.coordinator.isRefreshing = isRefreshing
        context.coordinator.attachIfNeeded(from: uiView)
        context.coordinator.syncRefreshState()
    }

    final class Coordinator: NSObject {
        var onRefresh: () -> Void
        var isRefreshing = false

        private weak var scrollView: UIScrollView?
        private weak var refreshControl: UIRefreshControl?

        init(onRefresh: @escaping () -> Void) {
            self.onRefresh = onRefresh
        }

        deinit {
            detach()
        }

        func attachIfNeeded(from probe: UIView) {
            guard let candidate = findBestScrollView(from: probe) else { return }
            guard candidate !== scrollView else { return }

            detach()

            scrollView = candidate
            candidate.alwaysBounceVertical = true
            let control = UIRefreshControl()
            control.addTarget(self, action: #selector(handleValueChanged(_:)), for: .valueChanged)
            candidate.refreshControl = control
            refreshControl = control
            syncRefreshState()
        }

        func syncRefreshState() {
            guard let scrollView, let refreshControl else { return }

            if isRefreshing {
                guard !refreshControl.isRefreshing else { return }

                DispatchQueue.main.async {
                    refreshControl.beginRefreshing()

                    let visibleOffset = -scrollView.adjustedContentInset.top - refreshControl.frame.height
                    if scrollView.contentOffset.y > visibleOffset {
                        scrollView.setContentOffset(
                            CGPoint(x: scrollView.contentOffset.x, y: visibleOffset),
                            animated: true
                        )
                    }
                }
            } else if refreshControl.isRefreshing {
                DispatchQueue.main.async {
                    refreshControl.endRefreshing()
                }
            }
        }

        @objc
        private func handleValueChanged(_ sender: UIRefreshControl) {
            guard !isRefreshing else {
                return
            }

            onRefresh()
        }

        private func detach() {
            if let refreshControl {
                refreshControl.removeTarget(self, action: #selector(handleValueChanged(_:)), for: .valueChanged)
                if scrollView?.refreshControl === refreshControl {
                    scrollView?.refreshControl = nil
                }
            }
            self.refreshControl = nil
            scrollView = nil
        }

        private func findBestScrollView(from probe: UIView) -> UIScrollView? {
            var current: UIView? = probe.superview

            while let view = current {
                if let scrollView = view as? UIScrollView {
                    return scrollView
                }
                current = view.superview
            }

            current = probe
            while let view = current {
                let candidates = collectScrollViews(in: view)
                if let match = candidates.max(by: { lhs, rhs in
                    let lhsArea = lhs.bounds.width * lhs.bounds.height
                    let rhsArea = rhs.bounds.width * rhs.bounds.height
                    return lhsArea < rhsArea
                }) {
                    return match
                }

                current = view.superview
            }

            return nil
        }

        private func collectScrollViews(in root: UIView) -> [UIScrollView] {
            var matches: [UIScrollView] = []

            if let scrollView = root as? UIScrollView {
                matches.append(scrollView)
            }

            for subview in root.subviews {
                matches.append(contentsOf: collectScrollViews(in: subview))
            }

            return matches
        }
    }
}

private final class ReleaseToRefreshProbeView: UIView {
    var onLayout: ((UIView) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isHidden = true
        isUserInteractionEnabled = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        onLayout?(self)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        onLayout?(self)
    }
}
#endif

extension View {
    @ViewBuilder
    func releaseToRefresh(
        isRefreshing: Bool,
        action: @escaping () -> Void
    ) -> some View {
        #if os(iOS)
        modifier(
            ReleaseToRefreshModifier(
                isRefreshing: isRefreshing,
                action: action
            )
        )
        #else
        self
        #endif
    }
}
