/// Small pieces that follow each platform's own conventions: on iPhone and
/// iPad, Apple's alert buttons (the default action bold, a destructive one in
/// red); elsewhere the Material ones.
library;

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import 'theme.dart';

/// One button of an [AlertDialog.adaptive].
Widget adaptiveAction(
  BuildContext context, {
  required String label,
  required VoidCallback onPressed,
  bool destructive = false,
  bool primary = false,
}) {
  final p = Theme.of(context).platform;
  if (p == TargetPlatform.iOS || p == TargetPlatform.macOS) {
    return CupertinoDialogAction(
      onPressed: onPressed,
      isDestructiveAction: destructive,
      isDefaultAction: primary,
      child: Text(label),
    );
  }
  if (primary) return FilledButton(onPressed: onPressed, child: Text(label));
  return TextButton(
    onPressed: onPressed,
    style: destructive ? TextButton.styleFrom(foregroundColor: Tp.danger) : null,
    child: Text(label),
  );
}
