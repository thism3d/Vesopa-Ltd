/// A staff card hands the till to somebody else, in one swipe.
///
/// The venue's report was that a swipe did nothing until the screen was
/// touched, and that is fixed in `ui/swipe_listener.dart` — the callback was
/// waiting for a frame nobody had asked for. This checks the other half of the
/// same journey: that when the card *does* arrive, it signs the right person on
/// straight away.
///
/// WHY "INSTANTLY" IS A THING TO TEST
///
/// Signing on with a card must not stop to ask anything. A clerk holding a card
/// to a reader has already identified themselves — the card is the credential,
/// exactly as the PIN is — so a prompt on top of it is a second question about
/// a fact already established, asked at a counter with a queue.
///
/// The tests below therefore assert on what is *absent* as much as on what
/// happens: no PIN pad, no picker, no confirmation. One swipe, and the name on
/// the till changes.
library;

import 'package:drift/drift.dart' show Value;
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/mock_card_reader.dart';
import 'package:vesopa_epos/data/staff_repository.dart';
import 'package:vesopa_epos/data/staff_session.dart';
import 'package:vesopa_epos/data/swipe_cards.dart';
import 'package:vesopa_epos/main.dart';

void main() {
  late AppDatabase db;

  /// Two people, two cards, two PINs. The point of every test here is telling
  /// one from the other.
  const alexCard = '999800001';
  const samCard = '999800002';

  Future<StaffData> addStaff(
    String name,
    String pin,
    int pluid,
    String card,
  ) async {
    await db.into(db.staff).insert(
      StaffCompanion.insert(
        id: Value(pluid),
        pluid: Value(pluid),
        name: name,
        pin: pin,
        swipeCard: Value(card),
      ),
    );
    return (db.select(db.staff)..where((s) => s.id.equals(pluid)))
        .getSingle();
  }

  setUp(() {
    TestWidgetsFlutterBinding.ensureInitialized();
    SharedPreferences.setMockInitialValues({});
    db = AppDatabase.forTesting(NativeDatabase.memory());
    addTearDown(() => db.close());
  });

  // ---------------------------------------------------------------------------
  // Finding the person
  // ---------------------------------------------------------------------------

  group('a swipe finds exactly one person', () {
    test('the card on the stripe is the person signed on', () async {
      await addStaff('Alex Morgan', '1234', 1, alexCard);
      await addStaff('Sam Reilly', '5678', 2, samCard);

      final repository = StaffRepository(
        apiBase: 'http://localhost',
        db: db,
        terminalToken: null,
      );

      expect((await repository.byCard(alexCard))?.name, 'Alex Morgan');
      expect((await repository.byCard(samCard))?.name, 'Sam Reilly');
    });

    test('and a card nobody holds signs nobody on', () async {
      await addStaff('Alex Morgan', '1234', 1, alexCard);

      final repository = StaffRepository(
        apiBase: 'http://localhost',
        db: db,
        // No terminal token, so there is no re-pull to fall back on: the cache
        // is the whole answer, and the answer is nobody.
        terminalToken: null,
      );
      expect(await repository.byCard('999899999'), isNull);
    });

    test('and an empty read never signs the first person on', () async {
      // Every member of staff without a card has an empty column, so an empty
      // needle would match whoever sorts first — a reader that sent nothing
      // would hand the till to somebody.
      await addStaff('Alex Morgan', '1234', 1, '');
      await addStaff('Sam Reilly', '5678', 2, samCard);

      final repository = StaffRepository(
        apiBase: 'http://localhost',
        db: db,
        terminalToken: null,
      );
      expect(await repository.byCard(''), isNull);
      expect(await repository.byCard('   '), isNull);
    });
  });

  // ---------------------------------------------------------------------------
  // Handing the till over
  // ---------------------------------------------------------------------------

  group('the till changes hands', () {
    /// A container with a real database and a real staff session.
    ProviderContainer containerWith() {
      final container = ProviderContainer(
        overrides: [databaseProvider.overrideWithValue(db)],
      );
      addTearDown(container.dispose);
      return container;
    }

    test('signing on with a card puts that name on the till', () async {
      final alex = await addStaff('Alex Morgan', '1234', 1, alexCard);
      final container = containerWith();

      expect(container.read(staffSessionProvider).signedOn, isFalse);

      container.read(staffSessionProvider.notifier).signOn(alex);
      final session = container.read(staffSessionProvider);

      expect(session.signedOn, isTrue);
      expect(session.name, 'Alex Morgan');
      expect(session.staff?.id, alex.id);
    });

    test('a second card replaces the first person, it does not stack', () async {
      // The reported case: a colleague steps in mid-service. The till must be
      // *theirs* afterwards, not both of theirs — every sale from here is
      // attributed to whoever is on, and two sessions would make that a guess.
      final alex = await addStaff('Alex Morgan', '1234', 1, alexCard);
      final sam = await addStaff('Sam Reilly', '5678', 2, samCard);
      final container = containerWith();

      container.read(staffSessionProvider.notifier).signOn(alex);
      expect(container.read(staffSessionProvider).name, 'Alex Morgan');

      container.read(staffSessionProvider.notifier).signOn(sam);
      final session = container.read(staffSessionProvider);

      expect(session.name, 'Sam Reilly');
      expect(session.staff?.id, sam.id);
    });

    test('and it does not put the idle screen up on the way', () async {
      // A handover is a change of who is responsible, not a lock. Dropping to
      // the screensaver between two people would make a one-second swap a
      // three-step one, which is the whole reason the Sign On key exists.
      final alex = await addStaff('Alex Morgan', '1234', 1, alexCard);
      final sam = await addStaff('Sam Reilly', '5678', 2, samCard);
      final container = containerWith();

      container.read(staffSessionProvider.notifier).signOn(alex);
      container.read(staffSessionProvider.notifier).signOn(sam);

      expect(container.read(staffSessionProvider).idle, isFalse);
      expect(container.read(staffSessionProvider).promptPin, isFalse);
    });
  });

  // ---------------------------------------------------------------------------
  // The card as the reader sends it
  // ---------------------------------------------------------------------------

  group('what comes off the stripe', () {
    test('sentinels are not part of the number looked up', () async {
      // The reader types `;999800001?`. Looking that up would find nobody, and
      // the venue would be told their card was not recognised while holding a
      // card that is.
      final buffer = SwipeBuffer();
      final card = MockCardReader.typeInto(buffer, number: alexCard);

      expect(card, isNotNull);
      expect(card!.number, alexCard);
      expect(card.raw, ';$alexCard?');

      await addStaff('Alex Morgan', '1234', 1, alexCard);
      final repository = StaffRepository(
        apiBase: 'http://localhost',
        db: db,
        terminalToken: null,
      );
      expect((await repository.byCard(card.number))?.name, 'Alex Morgan');
    });

    test('a card read twice in a row is still the same person', () async {
      // The venue swiped repeatedly when nothing appeared. Each read has to be
      // independent — a second swipe must not be poisoned by the first.
      final buffer = SwipeBuffer();
      var clock = DateTime(2026, 9, 5, 12);

      for (var attempt = 0; attempt < 3; attempt++) {
        final card = MockCardReader.typeInto(
          buffer,
          number: samCard,
          at: clock,
        );
        expect(card?.number, samCard, reason: 'attempt $attempt');
        clock = clock.add(const Duration(seconds: 2));
      }
    });
  });
}
