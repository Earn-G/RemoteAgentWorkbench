import Combine
import Foundation

final class TaskEventStream: NSObject {
    private let request: URLRequest
    private let decoder = JSONDecoder()
    private let subject = PassthroughSubject<TaskSnapshot, APIError>()
    private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)

    private var dataTask: URLSessionDataTask?
    private var buffer = ""
    private var currentEvent = ""
    private var payloadLines: [String] = []
    private var hasCompleted = false

    init(request: URLRequest) {
        self.request = request
        super.init()
    }

    func publisher() -> AnyPublisher<TaskSnapshot, APIError> {
        startIfNeeded()

        return subject
            .handleEvents(
                receiveCompletion: { [weak self] _ in
                    self?.stop(sendFinished: false)
                },
                receiveCancel: { [weak self] in
                    self?.stop(sendFinished: true)
                }
            )
            .eraseToAnyPublisher()
    }

    private func startIfNeeded() {
        guard dataTask == nil else { return }
        let task = session.dataTask(with: request)
        dataTask = task
        task.resume()
    }

    private func stop(sendFinished: Bool) {
        dataTask?.cancel()
        dataTask = nil
        session.invalidateAndCancel()

        guard sendFinished, !hasCompleted else { return }
        hasCompleted = true
        subject.send(completion: .finished)
    }

    private func fail(_ error: APIError) {
        guard !hasCompleted else { return }
        hasCompleted = true
        subject.send(completion: .failure(error))
        stop(sendFinished: false)
    }

    private func process(_ data: Data) {
        buffer.append(String(decoding: data, as: UTF8.self))

        while let range = buffer.range(of: "\n") {
            let line = String(buffer[..<range.lowerBound])
            buffer.removeSubrange(buffer.startIndex...range.lowerBound)
            handleLine(line.trimmingCharacters(in: .newlines))
        }
    }

    private func handleLine(_ line: String) {
        if line.hasPrefix("event:") {
            currentEvent = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
            return
        }

        if line.hasPrefix("data:") {
            payloadLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
            return
        }

        guard line.isEmpty else {
            return
        }

        let payload = payloadLines.joined(separator: "\n")
        defer {
            currentEvent = ""
            payloadLines = []
        }

        guard currentEvent == "task.snapshot", !payload.isEmpty else {
            return
        }

        do {
            let snapshot = try decoder.decode(TaskSnapshot.self, from: Data(payload.utf8))
            subject.send(snapshot)
        } catch {
            fail(.streamDecodingFailed(message: error.localizedDescription))
        }
    }
}

extension TaskEventStream: URLSessionDataDelegate {
    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard let httpResponse = response as? HTTPURLResponse else {
            fail(.invalidResponse)
            completionHandler(.cancel)
            return
        }

        guard (200 ..< 300).contains(httpResponse.statusCode) else {
            fail(.requestFailed(statusCode: httpResponse.statusCode, message: HTTPURLResponse.localizedString(forStatusCode: httpResponse.statusCode)))
            completionHandler(.cancel)
            return
        }

        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        process(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error as NSError? {
            if error.domain == NSURLErrorDomain, error.code == NSURLErrorCancelled {
                guard !hasCompleted else { return }
                hasCompleted = true
                subject.send(completion: .finished)
                return
            }

            fail(.streamFailed(message: error.localizedDescription))
            return
        }

        guard !hasCompleted else { return }
        hasCompleted = true
        subject.send(completion: .finished)
    }
}
