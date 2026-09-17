import SwiftUI

/// The Vesopa Kitchen on Apple Watch: the card to show at the till, the
/// points, the membership and the latest news, four pages one swipe apart.
///
/// Nothing here talks to the server. The iPhone app sends the card over
/// WatchConnectivity whenever it has fresh figures (Runner/WatchBridge.swift),
/// and the watch keeps the last one, so the code still shows at a counter with
/// the phone left in a bag or out of range.
///
/// The App Store screenshots are drawn from these screens
/// (Documents\The Vesopa Kitchen Play Listing\Working\compose_watch.py);
/// change one and change the other.
@main
struct VesopaWatchApp: App {
  @StateObject private var store = CardStore()

  var body: some Scene {
    WindowGroup {
      RootView()
        .environmentObject(store)
    }
  }
}

struct RootView: View {
  @EnvironmentObject private var store: CardStore

  var body: some View {
    if store.card.signedIn {
      TabView {
        NavigationStack { CardView() }
        NavigationStack { PointsView() }
        NavigationStack { MembershipView() }
        NavigationStack { NewsView() }
      }
      .tabViewStyle(.verticalPage)
    } else {
      NavigationStack { SignedOutView() }
    }
  }
}

/// Before the phone has sent a card, or after signing out on the phone.
struct SignedOutView: View {
  var body: some View {
    ScrollView {
      VStack(spacing: 10) {
        Image(systemName: "iphone")
          .font(.system(size: 34, weight: .semibold))
          .foregroundStyle(.tint)
        Text("Open The Vesopa Kitchen on your iPhone and sign in. Your card appears here.")
          .font(.footnote)
          .multilineTextAlignment(.center)
          .foregroundStyle(.secondary)
      }
      .padding(.top, 8)
    }
    .navigationTitle("Kitchen")
  }
}

/// The grey rounded panel the membership rows and the news sit on.
struct Panel<Content: View>: View {
  @ViewBuilder var content: Content

  var body: some View {
    content
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 10)
      .padding(.vertical, 9)
      .background(Color(white: 0.11), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
  }
}
