import SwiftUI

struct MembershipView: View {
  @EnvironmentObject private var store: CardStore

  var body: some View {
    ScrollView {
      VStack(spacing: 5) {
        ForEach(Array(store.card.rows.enumerated()), id: \.offset) { _, row in
          Panel {
            HStack(alignment: .firstTextBaseline) {
              Text(row.label).foregroundStyle(Color(white: 0.71))
              Spacer(minLength: 6)
              Text(row.value).fontWeight(.bold).lineLimit(1).minimumScaleFactor(0.7)
            }
            .font(.body)
          }
        }
      }
    }
    .navigationTitle("Membership")
  }
}
