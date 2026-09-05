/// "You are not allowed to do that — shall I fetch someone who is?"
///
/// Every restricted key on the till goes through [allowed]. It answers from the
/// signed-on clerk's own permission group, cached locally so it works with the
/// broadband down — see `data/till_permissions.dart`.
///
/// WHY A REFUSAL OFFERS AN OVERRIDE INSTEAD OF JUST SAYING NO
///
/// The thing that actually happens at a counter is this: a customer wants a
/// refund, the person serving them cannot do refunds, and a manager is ten feet
/// away. A till that only says "not allowed" makes the clerk sign off, fetch
/// the manager, have *them* sign on, do the refund, sign off again, and hand
/// the till back — six steps, a queue, and every one of those sales now
/// attributed to the manager.
///
/// So a refusal offers the override in place. The manager types their PIN, the
/// one action goes through, and the clerk stays signed on and keeps their name
/// on the bill. That is what a permission system is for; refusing outright is
/// what makes venues turn one off.
///
/// WHO MAY APPROVE
///
/// Somebody who holds the key themselves, or somebody marked Is Manager. Not
/// "any other member of staff" — that is a permission system a clerk can walk
/// around by asking the person next to them.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/staff_session.dart';
import '../data/till_permissions.dart';
import '../main.dart';
import 'pin_dialog.dart';
import 'widgets/pos_message.dart';

/// What the signed-on member of staff may do.
///
/// Unrestricted where nobody is signed on, which sounds wrong and is not: a
/// till with no session is one where sign-on is switched off entirely, and
/// every one of those has been operating with every key since before groups
/// existed. Refusing there would break a working venue to enforce a rule it has
/// not opted into.
TillPermissions permissionsOf(WidgetRef ref) {
  final staff = ref.read(staffSessionProvider).staff;
  if (staff == null) return TillPermissions.unrestricted;
  return TillPermissions.parse(staff.permissions);
}

/// May this happen? Asks a manager if not.
///
/// Returns true when the action should go ahead — either because the clerk
/// holds the key, or because somebody who does has just approved it.
Future<bool> allowed(
  BuildContext context,
  WidgetRef ref,
  TillPermission permission,
) async {
  final staff = ref.read(staffSessionProvider).staff;
  if (staff == null) return true;

  if (TillPermissions.parse(staff.permissions).can(permission)) return true;

  final approved = await _askAManager(context, ref, permission, staff.name);
  return approved;
}

/// Put the override up and check whoever answers it.
Future<bool> _askAManager(
  BuildContext context,
  WidgetRef ref,
  TillPermission permission,
  String clerkName,
) async {
  final go = await showDialog<bool>(
    context: context,
    builder: (dialog) => AlertDialog(
      icon: const Icon(Icons.lock_outline),
      title: const Text('Needs approval'),
      content: Text(
        '$clerkName is not set up to ${permission.verb}.\n\n'
        'A manager can approve this one without anybody signing off.',
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(dialog).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(dialog).pop(true),
          child: const Text('Ask a manager'),
        ),
      ],
    ),
  );
  if (go != true || !context.mounted) return false;

  final pin = await askForPin(context, "Manager's PIN");
  if (pin == null || !context.mounted) return false;

  final manager = await ref.read(staffRepositoryProvider).byPin(pin);
  if (!context.mounted) return false;

  if (manager == null) {
    PosMessenger.error(context, 'That PIN was not recognised.');
    return false;
  }

  // Either the key itself, or the standing to grant it. Checked against the
  // approver's own group and not against the clerk's.
  final theirs = TillPermissions.parse(manager.permissions);
  if (!theirs.can(permission) && !theirs.can(TillPermission.isManager)) {
    PosMessenger.error(
      context,
      '${manager.name} is not set up to ${permission.verb} either.',
    );
    return false;
  }

  // Named, because an override is a thing a venue will want to ask about later
  // and "somebody approved it" is not an answer.
  PosMessenger.success(context, 'Approved by ${manager.name}.');
  return true;
}
