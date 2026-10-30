/// Redeeming a staff drink slip (2026-10-30, data/staff_drinks.dart).
///
/// Scanned (the slip's barcode, read like any other scan) or typed from the
/// Staff Drink key. The answer is said in one big line the bar can act on:
/// pour it, or it has been used, with when and where.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../data/staff_drinks.dart';
import '../data/terminal_identity.dart' show terminalNameProvider;
import '../main.dart';
import 'sale_page.dart' show askTillField;

/// Redeem [code], or ask for it when it was not scanned.
Future<void> redeemStaffDrink(BuildContext context, WidgetRef ref, {String? code}) async {
  final typed = code ??
      await askTillField(
        context,
        'Staff drink',
        hint: 'The code on the slip, SD and eight letters and numbers',
      );
  if (typed == null || typed.trim().isEmpty || !context.mounted) return;

  final result = await ref.read(staffDrinksProvider).redeem(
        typed,
        by: ref.read(servedByProvider),
        terminal: ref.read(terminalNameProvider),
      );
  if (!context.mounted) return;

  final when = DateFormat('EEE d MMM, HH:mm');
  final scheme = Theme.of(context).colorScheme;
  final (IconData icon, Color colour, String title, String body) = switch (result) {
    StaffDrinkOk(:final drink) => (
        Icons.check_circle_rounded,
        const Color(0xFF2E7D32),
        drink.productName,
        [
          'Pour it: this slip is now used.',
          if (drink.issuedAt != null)
            'Bought ${when.format(drink.issuedAt!)}${drink.soldBy == null ? '' : ', sold by ${drink.soldBy}'}.',
        ].join('\n'),
      ),
    StaffDrinkUsed(:final drink) => (
        Icons.block_rounded,
        scheme.error,
        'Already used',
        [
          '${drink.productName}: this slip was used'
              '${drink.redeemedAt == null ? '' : ' on ${when.format(drink.redeemedAt!)}'}'
              '${drink.redeemedTerminal == null ? '' : ' at ${drink.redeemedTerminal}'}'
              '${drink.redeemedBy == null ? '' : ' (${drink.redeemedBy})'}.',
          'Do not pour it.',
        ].join('\n'),
      ),
    StaffDrinkRefused(:final message) => (Icons.error_outline_rounded, scheme.error, 'Not redeemed', message),
  };

  await showDialog<void>(
    context: context,
    builder: (c) => AlertDialog(
      icon: Icon(icon, size: 48, color: colour),
      title: Text(title, textAlign: TextAlign.center),
      content: Text(body, textAlign: TextAlign.center, style: const TextStyle(fontSize: 18)),
      actions: [FilledButton(onPressed: () => Navigator.pop(c), child: const Text('OK'))],
    ),
  );
}
