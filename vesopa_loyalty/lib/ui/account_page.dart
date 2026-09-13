import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/api.dart';
import '../data/session.dart';
import '../platform/passkey.dart';
import '../platform/push.dart';
import 'widgets.dart';

/// What this member can change about themselves, and what they can prove.
///
/// EVERYTHING HERE IS THE VENUE'S TO ALLOW. A venue whose membership list is
/// its own record switches self-service off, and then this page shows the same
/// facts with nothing to press — which is more use than hiding it, because the
/// member can still read their details out to somebody at the venue.
///
/// A method the venue does not offer does not appear at all. There is no point
/// letting somebody set a password for a venue that will not accept one.
final accountProvider = FutureProvider<Map<String, dynamic>>((ref) async {
  final token = await ref.watch(sessionProvider.future);
  if (token == null) throw ApiError('Please sign in.', status: 401);
  return ref.read(apiProvider).account();
});

class AccountPage extends ConsumerWidget {
  const AccountPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final account = ref.watch(accountProvider);
    return account.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => LoadFailed(error: e, onRetry: () => ref.invalidate(accountProvider)),
      data: (a) => RefreshIndicator(
        onRefresh: () => ref.refresh(accountProvider.future),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 640),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
              children: [
                _You(account: a),
                const SizedBox(height: 10),
                _Security(account: a),
                const SizedBox(height: 10),
                _Devices(account: a),
                const SizedBox(height: 10),
                const _LeaveCard(),
                const SizedBox(height: 22),
                const PoweredBy(),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Who they are
// ---------------------------------------------------------------------------

class _You extends ConsumerWidget {
  const _You({required this.account});

  final Map<String, dynamic> account;

  Future<void> _rename(BuildContext context, WidgetRef ref) async {
    final controller = TextEditingController(text: '${account['name'] ?? ''}');
    final name = await showDialog<String>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: const Text('The name on your card'),
        content: TextField(
          controller: controller,
          autofocus: true,
          textCapitalization: TextCapitalization.words,
          decoration: const InputDecoration(labelText: 'Your name'),
          onSubmitted: (v) => Navigator.pop(dialog, v.trim()),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialog), child: const Text('Cancel')),
          FilledButton(
            onPressed: () => Navigator.pop(dialog, controller.text.trim()),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    controller.dispose();
    if (name == null || name.isEmpty || !context.mounted) return;
    await runWithFeedback(context, ref, () async {
      await ref.read(apiProvider).setName(name);
      ref
        ..invalidate(accountProvider)
        // The card carries the name, so it is stale the moment this changes.
        ..invalidate(meProvider);
    }, done: 'Name changed.');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final canEdit = account['can_edit'] != false;
    return SettingsCard(
      title: 'You',
      children: [
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.badge_outlined),
          title: const Text('Name'),
          subtitle: Text('${account['name'] ?? ''}'),
          trailing: canEdit ? const Icon(Icons.chevron_right) : null,
          onTap: canEdit ? () => _rename(context, ref) : null,
        ),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.alternate_email),
          title: const Text('Email address'),
          subtitle: Text('${account['email'] ?? ''}'),
          // Deliberately not editable here. An email address IS the way back
          // into this membership, so changing it is the venue's to do at the
          // till where somebody can be recognised — not a field on a phone
          // that has been left unlocked on a table.
          trailing: const Tooltip(
            message: 'Ask at the venue to change this',
            child: Icon(Icons.lock_outline, size: 18),
          ),
        ),
        _PhoneRow(account: account),
        if (account['vesopa_linked'] == true)
          const ListTile(
            contentPadding: EdgeInsets.zero,
            leading: Icon(Icons.verified_user_outlined),
            title: Text('Vesopa account'),
            subtitle: Text('Connected'),
          ),
      ],
    );
  }
}

class _PhoneRow extends ConsumerWidget {
  const _PhoneRow({required this.account});

  final Map<String, dynamic> account;

  Future<void> _add(BuildContext context, WidgetRef ref) async {
    final phone = TextEditingController();
    final code = TextEditingController();
    var sent = false;

    await showDialog<void>(
      context: context,
      builder: (dialog) => StatefulBuilder(
        builder: (dialog, setLocal) => AlertDialog(
          title: Text(sent ? 'Enter the code' : 'Add your mobile number'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: phone,
                enabled: !sent,
                keyboardType: TextInputType.phone,
                decoration: const InputDecoration(labelText: 'Mobile number', hintText: '07…'),
              ),
              if (sent) ...[
                const SizedBox(height: 12),
                TextField(
                  controller: code,
                  autofocus: true,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(labelText: 'Code from the text'),
                ),
              ],
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialog), child: const Text('Cancel')),
            FilledButton(
              onPressed: () async {
                if (!sent) {
                  final ok = await runWithFeedback(
                    dialog, ref,
                    () => ref.read(apiProvider).addPhone(phone.text.trim()),
                    done: 'Code sent.',
                  );
                  if (ok) setLocal(() => sent = true);
                  return;
                }
                final ok = await runWithFeedback(dialog, ref, () async {
                  await ref.read(apiProvider).confirmPhone(
                    phone: phone.text.trim(),
                    code: code.text.trim(),
                  );
                  ref.invalidate(accountProvider);
                }, done: 'Number confirmed.');
                if (ok && dialog.mounted) Navigator.pop(dialog);
              },
              child: Text(sent ? 'Confirm' : 'Text me a code'),
            ),
          ],
        ),
      ),
    );
    phone.dispose();
    code.dispose();
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final canEdit = account['can_edit'] != false;
    final phone = account['phone'] as String?;
    final verified = account['phone_verified'] == true;
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: const Icon(Icons.smartphone_outlined),
      title: const Text('Mobile number'),
      subtitle: Text(
        phone == null || phone.isEmpty
            ? 'Not added'
            : verified
                ? '$phone · confirmed'
                // A number the till typed in is not one we may text a sign-in
                // code to. Saying so is the difference between "it is broken"
                // and "there is one more step".
                : '$phone · not confirmed yet',
      ),
      trailing: canEdit
          ? (verified
              ? TextButton(
                  onPressed: () => runWithFeedback(context, ref, () async {
                    await ref.read(apiProvider).removePhone();
                    ref.invalidate(accountProvider);
                  }, done: 'Number removed.'),
                  child: const Text('Remove'),
                )
              : const Icon(Icons.chevron_right))
          : null,
      onTap: canEdit && !verified ? () => _add(context, ref) : null,
    );
  }
}

// ---------------------------------------------------------------------------
// What they can prove
// ---------------------------------------------------------------------------

class _Security extends ConsumerWidget {
  const _Security({required this.account});

  final Map<String, dynamic> account;

  List<String> get _methods => (account['methods'] as List? ?? const []).cast<String>();

  Future<void> _password(BuildContext context, WidgetRef ref, {required bool has}) async {
    final current = TextEditingController();
    final next = TextEditingController();
    await showDialog<void>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: Text(has ? 'Change your password' : 'Set a password'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (has)
              TextField(
                controller: current,
                obscureText: true,
                decoration: const InputDecoration(labelText: 'Current password'),
              ),
            if (has) const SizedBox(height: 12),
            TextField(
              controller: next,
              obscureText: true,
              autofocus: !has,
              decoration: const InputDecoration(
                labelText: 'New password',
                helperText: 'At least 8 characters. A phrase you will remember beats a short muddle.',
                helperMaxLines: 3,
              ),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialog), child: const Text('Cancel')),
          FilledButton(
            onPressed: () async {
              final ok = await runWithFeedback(dialog, ref, () async {
                await ref.read(apiProvider).setPassword(
                  current: has ? current.text : null,
                  password: next.text,
                );
                ref.invalidate(accountProvider);
              }, done: has ? 'Password changed.' : 'Password set.');
              if (ok && dialog.mounted) Navigator.pop(dialog);
            },
            child: const Text('Save'),
          ),
        ],
      ),
    );
    current.dispose();
    next.dispose();
  }

  Future<void> _addPasskey(BuildContext context, WidgetRef ref) async {
    await runWithFeedback(context, ref, () async {
      final api = ref.read(apiProvider);
      final options = await api.passkeyRegistrationOptions();
      final result = await passkeyCreate(options);
      await api.addPasskey(challenge: result.challenge, credential: result.credential);
      ref.invalidate(accountProvider);
    }, done: 'Passkey added.');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final canEdit = account['can_edit'] != false;
    final hasPassword = account['has_password'] == true;
    final passkeys = (account['passkeys'] as List? ?? const []).cast<Map<String, dynamic>>();
    final offersPassword = _methods.contains('password');
    final offersPasskey = _methods.contains('passkey');

    // Nothing this venue offers and nothing to show: a card with one line
    // saying "no settings" is worse than no card.
    if (!offersPassword && !offersPasskey && passkeys.isEmpty) return const SizedBox.shrink();

    return SettingsCard(
      title: 'Signing in',
      children: [
        if (offersPassword)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.password_outlined),
            title: const Text('Password'),
            subtitle: Text(hasPassword ? 'Set' : 'Not set — you sign in with a code'),
            trailing: canEdit ? const Icon(Icons.chevron_right) : null,
            onTap: canEdit ? () => _password(context, ref, has: hasPassword) : null,
          ),
        if (offersPasskey) ...[
          for (final k in passkeys)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.fingerprint),
              title: Text('${k['name'] ?? 'Passkey'}'),
              subtitle: Text(
                k['last_used_at'] != null
                    ? 'Last used ${when(k['last_used_at'], time: false)}'
                    : 'Added ${when(k['created_at'], time: false)}',
              ),
              trailing: canEdit
                  ? TextButton(
                      onPressed: () => runWithFeedback(context, ref, () async {
                        await ref.read(apiProvider).removePasskey('${k['id']}');
                        ref.invalidate(accountProvider);
                      }, done: 'Passkey removed.'),
                      child: const Text('Remove'),
                    )
                  : null,
            ),
          if (canEdit)
            passkeysSupported()
                ? ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.add_moderator_outlined),
                    title: const Text('Add a passkey'),
                    subtitle: const Text('Sign in with your face, fingerprint or device PIN.'),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => _addPasskey(context, ref),
                  )
                : const ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(Icons.info_outline),
                    title: Text('Passkeys'),
                    // Said plainly rather than left as a button that does
                    // nothing: this app on this device genuinely cannot.
                    subtitle: Text('Open your card in a web browser to add one.'),
                  ),
        ],
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Leaving
// ---------------------------------------------------------------------------

/// Signing out, and giving the app up altogether.
///
/// The two are deliberately not the same button and not the same weight.
/// Signing out is ordinary and reversible. Removing the app signs out every
/// device, stops notifications and forgets the last position — so it asks
/// first, and says plainly that the membership and the points are the
/// venue's record and stay exactly where they are. Somebody tidying up their
/// phone must not be able to delete their points by accident.
class _LeaveCard extends ConsumerStatefulWidget {
  const _LeaveCard();

  @override
  ConsumerState<_LeaveCard> createState() => _LeaveCardState();
}

class _LeaveCardState extends ConsumerState<_LeaveCard> {
  var _busy = false;

  Future<void> _go({required bool remove}) async {
    if (remove) {
      final sure = await showDialog<bool>(
        context: context,
        builder: (d) => AlertDialog(
          title: const Text('Remove the app from your membership?'),
          content: const Text(
            'Every device you signed in on is signed out, notifications stop and your saved '
            'location is deleted. Your membership and points stay with the venue.',
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Remove')),
          ],
        ),
      );
      if (sure != true) return;
    }
    setState(() => _busy = true);
    final api = ref.read(apiProvider);
    final choices = await Choices.of(ref.read(configProvider).slug);
    try {
      final endpoint = await pushUnsubscribe();
      if (endpoint != null) await api.removePush(endpoint).catchError((_) {});
      if (remove) {
        await api.removeApp();
      } else {
        await api.signOut();
      }
    } catch (_) {
      // Signed out here regardless: the token is forgotten below, and a
      // member who cannot reach the server must still be able to leave.
    }
    await choices.setNotifications(false);
    await choices.setNearby(false);
    await ref.read(sessionProvider.notifier).clear();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SettingsCard(
      title: 'This device',
      children: [
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.logout),
          title: const Text('Sign out'),
          onTap: _busy ? null : () => _go(remove: false),
        ),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: Icon(Icons.delete_outline, color: theme.colorScheme.error),
          title: Text(
            'Remove the app from my membership',
            style: TextStyle(color: theme.colorScheme.error),
          ),
          onTap: _busy ? null : () => _go(remove: true),
        ),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Where they are signed in
// ---------------------------------------------------------------------------

class _Devices extends ConsumerWidget {
  const _Devices({required this.account});

  final Map<String, dynamic> account;

  static String _platform(Object? p) => switch (p) {
    'web' => 'Web browser',
    'windows' => 'Windows app',
    'android' => 'Android',
    'ios' => 'iPhone or iPad',
    _ => 'Device',
  };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final devices = (account['devices'] as List? ?? const []).cast<Map<String, dynamic>>();
    if (devices.isEmpty) return const SizedBox.shrink();
    return SettingsCard(
      title: 'Where you are signed in',
      children: [
        for (final d in devices)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: Icon(d['current'] == true ? Icons.check_circle : Icons.devices_other),
            title: Text(_platform(d['platform'])),
            subtitle: Text(
              d['current'] == true
                  ? 'This device'
                  : 'Last used ${when(d['last_seen_at'], time: false)}',
            ),
          ),
        if (devices.length > 1)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: OutlinedButton.icon(
              onPressed: () => runWithFeedback(context, ref, () async {
                await ref.read(apiProvider).signOutOthers();
                ref.invalidate(accountProvider);
              }, done: 'Other devices signed out.'),
              icon: const Icon(Icons.logout),
              label: const Text('Sign out everywhere else'),
            ),
          ),
      ],
    );
  }
}
