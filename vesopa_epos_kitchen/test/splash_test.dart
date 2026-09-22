import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos_kitchen/data/kitchen_branding.dart';
import 'package:vesopa_epos_kitchen/ui/splash_screen.dart';
import 'package:vesopa_epos_kitchen/ui/theme.dart';

/// The start screen.
///
/// What is worth testing here is not that it looks nice — it is the two
/// promises it makes to a kitchen, both of which are easy to break by accident
/// in a later edit:
///
///   * it **finishes**, exactly once, whether it is waited out or tapped away;
///   * it never becomes the thing the note in `main.dart` warned about, which
///     is a screen a chef has to sit through.
Widget _host(Widget child) =>
    MaterialApp(theme: Kds.theme(), home: Scaffold(body: child));

void main() {
  testWidgets('it shows the venue’s name and tagline', (tester) async {
    await tester.pumpWidget(
      _host(
        SplashScreen(
          branding: const KitchenBranding(
            appName: 'Bell Kitchen',
            tagline: 'Swansea',
          ),
          onDone: () {},
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 1300));

    expect(find.text('Bell Kitchen'), findsOneWidget);
    expect(find.text('Swansea'), findsOneWidget);
    // The default carries Vesopa's own footer, which a licensed reseller turns
    // off in the back office.
    expect(find.text('POWERED BY VESOPA'), findsOneWidget);

    await tester.pumpAndSettle();
  });

  testWidgets('an unbranded venue gets the product name', (tester) async {
    await tester.pumpWidget(
      _host(
        SplashScreen(
          branding: KitchenBranding.standard,
          onDone: () {},
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 1300));

    expect(find.text('Vesopa Kitchen'), findsOneWidget);
    await tester.pumpAndSettle();
  });

  testWidgets('“powered by” can be turned off', (tester) async {
    await tester.pumpWidget(
      _host(
        SplashScreen(
          branding: const KitchenBranding(showPoweredBy: false),
          onDone: () {},
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 1300));

    expect(find.text('POWERED BY VESOPA'), findsNothing);
    await tester.pumpAndSettle();
  });

  testWidgets('it finishes on its own, after the animation and the hold', (
    tester,
  ) async {
    var done = 0;
    await tester.pumpWidget(
      _host(
        SplashScreen(
          branding: const KitchenBranding(
            splashHold: Duration(milliseconds: 400),
          ),
          onDone: () => done++,
        ),
      ),
    );

    // Still up while the animation runs. A splash that cleared itself early
    // would flash a logo and vanish, which reads as a fault.
    await tester.pump(const Duration(milliseconds: 600));
    expect(done, 0);

    // Animation (1250ms) plus the hold (400ms).
    await tester.pump(const Duration(milliseconds: 1000));
    expect(done, 0, reason: 'it finished before the hold had run');

    await tester.pump(const Duration(milliseconds: 500));
    expect(done, 1);

    await tester.pumpAndSettle();
  });

  // The whole reason it is skippable: a chef who has restarted a screen
  // mid-service wants the board, not the branding.
  testWidgets('a tap clears it immediately', (tester) async {
    var done = 0;
    await tester.pumpWidget(
      _host(
        SplashScreen(
          branding: const KitchenBranding(splashHold: Duration(seconds: 6)),
          onDone: () => done++,
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 200));

    await tester.tap(find.byType(SplashScreen));
    await tester.pump();

    expect(done, 1);
    await tester.pumpAndSettle();
  });

  // The tap and the timer can both land, and on a slow frame in either order.
  // Finishing twice would pop a route that is no longer there.
  testWidgets('it finishes exactly once, even when tapped then waited out', (
    tester,
  ) async {
    var done = 0;
    await tester.pumpWidget(
      _host(
        SplashScreen(
          branding: const KitchenBranding(
            splashHold: Duration(milliseconds: 300),
          ),
          onDone: () => done++,
        ),
      ),
    );

    await tester.pump(const Duration(milliseconds: 200));
    await tester.tap(find.byType(SplashScreen));
    await tester.pump();
    expect(done, 1);

    // Well past the point the timer would have fired.
    await tester.pump(const Duration(seconds: 3));
    expect(done, 1, reason: 'it finished twice');

    await tester.pumpAndSettle();
  });

  testWidgets('a zero hold still plays the animation through', (tester) async {
    var done = 0;
    await tester.pumpWidget(
      _host(
        SplashScreen(
          branding: const KitchenBranding(splashHold: Duration.zero),
          onDone: () => done++,
        ),
      ),
    );

    await tester.pump(const Duration(milliseconds: 900));
    expect(done, 0, reason: 'it cut the animation short');

    // Two pumps, and the second has to *advance the clock*. The animation
    // completes during the first, which is the moment the zero-length hold is
    // scheduled, and a timer only fires when the test's clock moves — a bare
    // pump() would not do it. An artefact of the harness rather than of the
    // widget: on a real screen the loop is already turning.
    await tester.pump(const Duration(milliseconds: 600));
    await tester.pump(const Duration(milliseconds: 1));
    expect(done, 1);

    await tester.pumpAndSettle();
  });

  // A wall panel is 1024x768 at the small end and 1920x1080 at the usual one.
  // Nothing here may overflow at either, or the first thing a venue sees of
  // its own branding is a yellow-and-black stripe.
  for (final size in const [Size(1024, 768), Size(1280, 800), Size(1920, 1080)]) {
    testWidgets('nothing overflows at ${size.width.toInt()}x'
        '${size.height.toInt()}', (tester) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(
        _host(
          SplashScreen(
            branding: const KitchenBranding(
              appName: 'A Rather Long Venue Name Ltd',
              tagline: 'The one with the very long trading name, Swansea',
            ),
            onDone: () {},
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 1300));

      expect(tester.takeException(), isNull);
      await tester.pumpAndSettle();
    });
  }
}
