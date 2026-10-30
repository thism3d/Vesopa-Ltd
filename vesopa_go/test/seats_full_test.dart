import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_go/ui/pages/sign_in_flow.dart';
import 'package:vesopa_go/ui/theme.dart';

void main() {
  final now = DateTime(2026, 10, 30, 22);

  test('says how long ago each device was used', () {
    expect(SeatsFullSheet.lastUsed({'last_seen_at': DateTime(2026, 10, 30, 21, 5).toIso8601String()}, now), 'Used today, 21:05');
    expect(SeatsFullSheet.lastUsed({'last_seen_at': DateTime(2026, 10, 29, 12).toIso8601String()}, now), 'Used yesterday');
    expect(SeatsFullSheet.lastUsed({'last_seen_at': DateTime(2026, 10, 25, 12).toIso8601String()}, now), 'Used 5 days ago');
    expect(SeatsFullSheet.lastUsed({'signed_in_at': DateTime(2026, 8, 2, 12).toIso8601String()}, now), 'Last used 2 Aug 2026');
    expect(SeatsFullSheet.lastUsed(const {}, now), 'Not used yet');
  });

  testWidgets('every seat is listed, least used first, and Sign out asks first', (tester) async {
    Map<String, dynamic>? picked;
    await tester.pumpWidget(MaterialApp(
      theme: Tp.theme(Brightness.dark),
      home: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: FilledButton(
              onPressed: () async {
                picked = await showModalBottomSheet<Map<String, dynamic>>(
                  context: context,
                  isScrollControlled: true,
                  builder: (_) => SeatsFullSheet(limit: 3, seats: [
                    {'id': 'a', 'name': 'Android (Vesopa Go) 1395', 'last_seen_at': DateTime.now().toIso8601String()},
                    {'id': 'b', 'name': 'Android (Vesopa Go) 42C0', 'last_seen_at': DateTime(2026, 9, 1).toIso8601String()},
                    {'id': 'c', 'name': 'iPhone (Vesopa Go) 51B0', 'last_seen_at': DateTime(2026, 10, 1).toIso8601String()},
                  ]),
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    ));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('All 3 Vesopa Go licences are in use'), findsOneWidget);
    final top = tester.getTopLeft(find.text('Android (Vesopa Go) 42C0')).dy;
    final bottom = tester.getTopLeft(find.text('Android (Vesopa Go) 1395')).dy;
    expect(top, lessThan(bottom), reason: 'the one unused longest comes first');

    await tester.tap(find.text('Sign out').first);
    await tester.pumpAndSettle();
    expect(find.text('Sign out Android (Vesopa Go) 42C0?'), findsOneWidget);
    await tester.tap(find.text('Sign it out'));
    await tester.pumpAndSettle();
    expect(picked?['id'], 'b');
  });
}
