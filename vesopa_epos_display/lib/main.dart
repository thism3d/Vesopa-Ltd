/// Vesopa Customer Display.
///
/// The screen the customer looks at while their round is being rung up: their
/// bill on one half, the venue's adverts on the other, and the adverts across
/// the whole screen when the till has been quiet for a while.
///
/// **A separate application, on purpose.** It reads a small file the till
/// writes and has no other connection to it — no shared process, no plugin, no
/// port. A display doing video work cannot slow the till down, and a display
/// that falls over takes nothing with it: the till carries on selling and the
/// only thing anybody loses is the picture facing the customer.
///
/// See `vesopa_epos/lib/data/customer_display.dart` for the other end of the
/// file, and `lib/data/basket_feed.dart` for how this one reads it.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'ui/display_page.dart';
import 'ui/theme.dart';

void main() {
  runApp(const ProviderScope(child: VesopaDisplayApp()));
}

class VesopaDisplayApp extends StatelessWidget {
  const VesopaDisplayApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Vesopa Customer Display',
    debugShowCheckedModeBanner: false,
    theme: buildDisplayTheme(),
    // One theme, not a light and a dark one. See ui/theme.dart: this screen
    // faces a customer across a counter and a white panel at that distance is
    // a lamp pointed at them.
    home: const DisplayPage(),
  );
}
