/// Moving a bill from one table to another, and what to do when the table it
/// is going to already has people on it.
///
/// "Create a function for the top and bottom bars called Transfer. This
/// transfers one table to another. If there is something already on the table
/// it's being transferred to please create a pop up box saying merge table?
/// Yes or No"
///
/// ONE FLOW, TWO PLACES IT IS REACHED FROM
///
/// The floor plan has offered "Transfer to another table" from a parked bill's
/// sheet for some time, and it refused outright when the destination was
/// taken. The venue wants the same action on a bar key, for the bill in front
/// of the clerk, and wants the refusal turned into an offer.
///
/// Both go through here, so the two cannot drift into behaving differently —
/// which matters more than it sounds: a clerk who learns that Transfer offers
/// to merge, and then meets a Transfer that refuses, has learned nothing.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/table_repository.dart';
import '../main.dart';
import 'table_picker.dart';
import 'widgets/pos_message.dart';

/// Ask which table, move the bill there, and offer to merge if it is taken.
///
/// [orderId] is the bill being moved. Returns the table it ended up on, or
/// null if nothing happened — the clerk cancelled, or declined the merge.
///
/// Everything it does is said out loud through [PosMessenger]: a key that
/// appears to do nothing is a key a clerk presses four more times.
Future<int?> transferTable(
  BuildContext context,
  WidgetRef ref, {
  required String orderId,
}) async {
  final tables = ref.read(tableRepositoryProvider);

  // The floor plan, so the clerk taps the table rather than remembering its
  // number — and so an occupied table is visibly occupied before they choose
  // it. Falls back to plain number entry on a venue that has drawn no plan.
  final picked = await showTablePicker(context, ref);
  if (picked == null || !context.mounted) return null;
  final to = picked.number;

  try {
    await tables.transfer(orderId, to);
    if (context.mounted) {
      PosMessenger.success(context, 'Moved to table $to.');
    }
    return to;
  } on TableOccupied catch (busy) {
    if (!context.mounted) return null;

    /*
     * MERGE TABLE? YES OR NO.
     *
     * Asked rather than assumed in either direction. Refusing outright — what
     * this did before — leaves a clerk who has just pushed two tables together
     * with no way to do it at the till. Merging silently would fold one
     * party's round into another party's bill, which is money taken from the
     * wrong people.
     *
     * The question names the table and what is on it, because "merge?" on its
     * own is a question a clerk cannot answer: whether these two bills should
     * become one depends entirely on whether it is the same party.
     */
    final merge = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Merge table?'),
        content: Text(
          'Table ${busy.tableNumber} already has a bill on it'
          '${busy.existing.totalMinor > 0 ? ' for ${_money(busy.existing.totalMinor)}' : ''}.\n\n'
          'Merging puts this bill’s items onto that one. The covers are '
          'added together, and this bill closes.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('No'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Yes, merge'),
          ),
        ],
      ),
    );

    if (merge != true) {
      if (context.mounted) {
        PosMessenger.info(
          context,
          'Nothing moved — table ${busy.tableNumber} still has its own bill.',
        );
      }
      return null;
    }

    await tables.merge(orderId, busy.existing.id);
    if (context.mounted) {
      PosMessenger.success(
        context,
        'Merged onto table ${busy.tableNumber}.',
      );
    }
    return busy.tableNumber;
  } on Object catch (e) {
    // Anything else — a table number the floor plan does not know, a database
    // that would not write. Said rather than swallowed: a bill that did not
    // move and did not say so is a bill a clerk goes looking for on the wrong
    // table.
    if (context.mounted) {
      PosMessenger.error(context, 'That transfer did not happen. $e');
    }
    return null;
  }
}

String _money(int minor) => '£${(minor / 100).toStringAsFixed(2)}';
