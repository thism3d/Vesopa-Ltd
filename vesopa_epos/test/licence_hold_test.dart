// A pause from admin.vesopa.com, as each device app reads and shows it.
// ONE FILE, FOUR APPS, like lib/data/licence.dart and lib/ui/licence_panel.dart.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/licence.dart';
import 'package:vesopa_epos/ui/licence_panel.dart';

const _notice = 'Till has been paused and stops at Tue 6 Oct, 09:00. Please contact Vesopa.';

Widget _host(Widget child) => MaterialApp(home: Scaffold(body: child));

void main() {
  test('the hold and its notice are read from the server', () {
    final s = LicenceState.fromJson({
      'label': 'Till',
      'locked': false,
      'renewBy': '2026-10-06T08:00:00.000Z',
      'paused': 'paused',
      'notice': _notice,
    });
    expect(s.held, isTrue);
    expect(s.lapsing, isTrue);
    expect(s.notice, _notice);
  });

  test('a server from before holds reads as no hold', () {
    final s = LicenceState.fromJson({'label': 'Till', 'locked': false});
    expect(s.held, isFalse);
    expect(s.notice, isNull);
  });

  testWidgets('the strip shows the notice, and nothing without one', (tester) async {
    await tester.pumpWidget(_host(const LicenceNoticeStrip(
      state: LicenceState(label: 'Till', locked: false, paused: 'paused', notice: _notice),
    )));
    expect(find.text(_notice), findsOneWidget);

    await tester.pumpWidget(_host(const LicenceNoticeStrip(
      state: LicenceState(label: 'Till', locked: false),
    )));
    expect(find.byType(Text), findsNothing);
  });

  testWidgets('the settings panel says paused, not "please renew"', (tester) async {
    await tester.pumpWidget(_host(SingleChildScrollView(
      child: LicencePanel(
        state: LicenceState(
          label: 'Till',
          locked: false,
          renewBy: DateTime.utc(2026, 10, 6, 8),
          paused: 'paused',
          notice: _notice,
        ),
      ),
    )));
    expect(find.text(_notice), findsOneWidget);
    expect(find.textContaining('Please renew'), findsNothing);
  });

  testWidgets('the lock page names the pause', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: LicenceLockedPage(
        state: LicenceState(
          label: 'Till',
          locked: true,
          paused: 'removed',
          notice: 'Till has been removed from this venue. Please contact Vesopa.',
        ),
      ),
    ));
    expect(find.text('Till is removed'), findsOneWidget);
    expect(find.text('Till has been removed from this venue. Please contact Vesopa.'), findsOneWidget);
    expect(find.textContaining('subscription'), findsNothing);
  });
}
