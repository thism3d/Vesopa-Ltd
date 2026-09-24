/// Approving with a card instead of a PIN.
///
/// The rule that matters is not that the card works — it is that the card goes
/// to the *approval* and not to sign-on. A manager swiping to authorise a void
/// must not be signed on in place of the clerk, because that throws the clerk
/// off their own bill in the middle of a sale, which is the whole thing the
/// approval flow exists to avoid.
///
/// So these are about who gets the card, and about giving it back afterwards.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/swipe_cards.dart';
import 'package:vesopa_epos/ui/manager_approval.dart';

SwipedCard card(String number) =>
    SwipedCard(number: number, raw: ';$number?', via: ReadVia.swipe);

void main() {
  group('who gets the swipe', () {
    test('nothing is waiting, so the till keeps its own card', () {
      // The ordinary case, and the one that must not change: every swipe when
      // no approval is on screen goes to the till's own handler.
      expect(ManagerCardCapture.isWaiting, isFalse);
      expect(ManagerCardCapture.offer(card('999900001')), isFalse);
    });

    test('an approval that is waiting takes the card instead', () async {
      final taken = ManagerCardCapture.debugWaitForCard();
      expect(ManagerCardCapture.isWaiting, isTrue);

      expect(
        ManagerCardCapture.offer(card('999900001')),
        isTrue,
        reason: 'the till must be told the card was claimed',
      );
      expect((await taken)?.number, '999900001');
    });

    test('and only the one card — the next goes back to the till', () async {
      final taken = ManagerCardCapture.debugWaitForCard();
      ManagerCardCapture.offer(card('999900001'));
      await taken;

      // An approval takes exactly one card. A second swipe belongs to whatever
      // the till would ordinarily do with it — a customer's loyalty card
      // presented right behind the manager's, say.
      expect(ManagerCardCapture.isWaiting, isFalse);
      expect(ManagerCardCapture.offer(card('999800123')), isFalse);
    });

    test('a cancelled approval gives the reader back', () {
      ManagerCardCapture.debugWaitForCard();
      expect(ManagerCardCapture.isWaiting, isTrue);

      // What `dispose` does when the prompt is dismissed. Without it a card
      // swiped after a cancelled approval would disappear into a completer
      // nobody is listening to, and the reader would look broken.
      ManagerCardCapture.debugStop();

      expect(ManagerCardCapture.isWaiting, isFalse);
      expect(ManagerCardCapture.offer(card('999900001')), isFalse);
    });
  });
}
