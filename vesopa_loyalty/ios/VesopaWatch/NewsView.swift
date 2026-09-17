import SwiftUI

/// The venue's latest three messages. Reading them in full is for the phone.
struct NewsView: View {
  @EnvironmentObject private var store: CardStore

  var body: some View {
    ScrollView {
      VStack(spacing: 5) {
        if store.card.news.isEmpty {
          Text("No news yet")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.top, 20)
        }
        ForEach(store.card.news) { item in
          Panel {
            VStack(alignment: .leading, spacing: 2) {
              HStack(alignment: .firstTextBaseline, spacing: 5) {
                if item.unread {
                  Circle()
                    .fill(Color.accentColor)
                    .frame(width: 6, height: 6)
                    .accessibilityLabel("Unread")
                }
                Text(item.title).font(.body.weight(.semibold)).lineLimit(3)
              }
              Text(item.date).font(.footnote).foregroundStyle(.secondary)
            }
          }
        }
      }
    }
    .navigationTitle("News")
  }
}
