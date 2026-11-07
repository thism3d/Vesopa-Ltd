/// The app's version, at the foot of Settings in every mode (owner,
/// 2026-11-07: "in the app settings of any chosen show the version of the app").
library;

import 'package:flutter/material.dart';

import '../config/constants.dart' show goAppVersion;

class AppVersionLine extends StatelessWidget {
  const AppVersionLine({super.key});

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 8),
    child: Text(
      'Vesopa Go $goAppVersion',
      key: const ValueKey('app-version'),
      textAlign: TextAlign.center,
      style: Theme.of(context).textTheme.bodySmall,
    ),
  );
}
