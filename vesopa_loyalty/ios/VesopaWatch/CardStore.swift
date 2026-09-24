import Foundation
import WatchConnectivity

/// What the watch shows, as the iPhone last sent it.
///
/// The keys are the ones lib/data/watch_card.dart writes. `qrPng` is added on
/// the phone (Runner/WatchBridge.swift), because watchOS has no Core Image to
/// draw a QR code with.
struct WatchCard {
  struct News: Identifiable {
    let id: Int
    let title: String
    let date: String
    let unread: Bool
  }

  var signedIn = false
  var title = "Kitchen"
  var qrPng: Data?
  var number = ""
  var points = 0
  var worth = ""
  var tier = ""
  var canSpend = false
  var spendNote = ""
  var rows: [(label: String, value: String)] = []
  var news: [News] = []

  init(_ d: [String: Any] = [:]) {
    signedIn = d["signedIn"] as? Bool ?? false
    if let t = d["title"] as? String, !t.isEmpty { title = t }
    qrPng = d["qrPng"] as? Data
    number = d["number"] as? String ?? ""
    points = (d["points"] as? NSNumber)?.intValue ?? 0
    worth = d["worth"] as? String ?? ""
    tier = d["tier"] as? String ?? ""
    canSpend = d["canSpend"] as? Bool ?? false
    spendNote = d["spendNote"] as? String ?? ""
    rows = (d["rows"] as? [[String]] ?? []).compactMap { $0.count == 2 ? (label: $0[0], value: $0[1]) : nil }
    news = (d["news"] as? [[String: Any]] ?? []).enumerated().map { i, n in
      News(
        id: i,
        title: n["title"] as? String ?? "",
        date: n["date"] as? String ?? "",
        unread: n["unread"] as? Bool ?? false
      )
    }
  }
}

final class CardStore: NSObject, ObservableObject, WCSessionDelegate {
  private static let saved = "card"

  @Published private(set) var card: WatchCard

  override init() {
    card = WatchCard(UserDefaults.standard.dictionary(forKey: Self.saved) ?? [:])
    super.init()
    if WCSession.isSupported() {
      WCSession.default.delegate = self
      WCSession.default.activate()
    }
  }

  private func apply(_ context: [String: Any]) {
    guard !context.isEmpty else { return }
    DispatchQueue.main.async {
      UserDefaults.standard.set(context, forKey: Self.saved)
      self.card = WatchCard(context)
    }
  }

  func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
    apply(session.receivedApplicationContext)
    // Ask the phone for its latest, in case the card changed while the watch
    // app was not running. Only answered while the iPhone app is running too.
    if state == .activated, session.isReachable {
      session.sendMessage(["want": "card"], replyHandler: nil, errorHandler: nil)
    }
  }

  func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
    apply(applicationContext)
  }
}
