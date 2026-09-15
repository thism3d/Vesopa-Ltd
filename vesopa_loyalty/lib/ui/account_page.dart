import 'package:flutter/foundation.dart' show defaultTargetPlatform, kIsWeb, TargetPlatform;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

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
                const _Membership(),
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
        const _PhotoRow(),
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

/// The member's photograph, on their card at the till.
///
/// THE MEMBER'S OWN TO ADD. The venue could always attach one in the back
/// office; now the person can, from the camera or the gallery, and it
/// reaches the till the same way. A clerk who can see it is them is the
/// whole point of a photo on a membership.
///
/// The picture is scaled down before it leaves the phone -- a 12-megapixel
/// photograph is not a face for a 60-pixel circle -- and a browser gets a
/// file picker, which on a phone opens the camera anyway.
class _PhotoRow extends ConsumerWidget {
  const _PhotoRow();

  Future<void> _change(BuildContext context, WidgetRef ref) async {
    final phone = !kIsWeb && (defaultTargetPlatform == TargetPlatform.android || defaultTargetPlatform == TargetPlatform.iOS);
    var source = ImageSource.gallery;
    if (phone) {
      final chosen = await showModalBottomSheet<ImageSource>(
        context: context,
        showDragHandle: true,
        builder: (sheet) => SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ListTile(
                leading: const Icon(Icons.photo_camera_outlined),
                title: const Text('Take a photo'),
                onTap: () => Navigator.pop(sheet, ImageSource.camera),
              ),
              ListTile(
                leading: const Icon(Icons.photo_library_outlined),
                title: const Text('Choose from your photos'),
                onTap: () => Navigator.pop(sheet, ImageSource.gallery),
              ),
              const SizedBox(height: 8),
            ],
          ),
        ),
      );
      if (chosen == null) return;
      source = chosen;
    }
    final XFile? picked;
    try {
      picked = await ImagePicker().pickImage(
        source: source,
        maxWidth: 900,
        maxHeight: 900,
        imageQuality: 85,
        preferredCameraDevice: CameraDevice.front,
      );
    } catch (_) {
      if (context.mounted) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(content: Text('The camera or photos could not be opened.'), behavior: SnackBarBehavior.floating),
        );
      }
      return;
    }
    if (picked == null || !context.mounted) return;
    final bytes = await picked.readAsBytes();
    final filename = picked.name.isEmpty ? 'photo.jpg' : picked.name;
    if (!context.mounted) return;
    await runWithFeedback(context, ref, () async {
      await ref.read(apiProvider).uploadPhoto(bytes, filename);
      ref.invalidate(meProvider);
    }, done: 'Your photo is on your card.');
  }

  Future<void> _remove(BuildContext context, WidgetRef ref) async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: const Text('Remove your photo?'),
        content: const Text('Your card will show your initials instead.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialog, false), child: const Text('Keep it')),
          FilledButton(onPressed: () => Navigator.pop(dialog, true), child: const Text('Remove')),
        ],
      ),
    );
    if (sure != true || !context.mounted) return;
    await runWithFeedback(context, ref, () async {
      await ref.read(apiProvider).removePhoto();
      ref.invalidate(meProvider);
    }, done: 'Photo removed.');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(meProvider).value ?? const <String, dynamic>{};
    final brand = ref.watch(brandProvider).value;
    final url = me['photo_url'] as String?;
    final api = ref.read(apiProvider);
    final name = '${me['name'] ?? ''}'.trim();
    final initials = name.isEmpty
        ? '?'
        : name.split(RegExp(r'\s+')).take(2).map((w) => w.isEmpty ? '' : w[0].toUpperCase()).join();
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: CircleAvatar(
        radius: 26,
        backgroundColor: brand?.iconColour.withValues(alpha: 0.2),
        foregroundImage: url == null || url.isEmpty ? null : NetworkImage(api.resolve(url)),
        child: Text(initials, style: TextStyle(fontWeight: FontWeight.w800, color: brand?.text)),
      ),
      title: const Text('Your photo'),
      subtitle: Text(url == null || url.isEmpty ? 'Add one so the venue knows it is you' : 'Shown on your card at the till'),
      trailing: Wrap(
        spacing: 4,
        children: [
          if (url != null && url.isNotEmpty)
            IconButton(tooltip: 'Remove', icon: const Icon(Icons.delete_outline), onPressed: () => _remove(context, ref)),
          IconButton(
            tooltip: url == null || url.isEmpty ? 'Add a photo' : 'Change photo',
            icon: const Icon(Icons.add_a_photo_outlined),
            onPressed: () => _change(context, ref),
          ),
        ],
      ),
      onTap: () => _change(context, ref),
    );
  }
}

/// The membership: when it runs to, what the venue's term and fee are, and
/// how to renew.
///
/// Read off /me, which carries the venue's scheme beside the member's date.
/// A venue with no expiry set on the member shows nothing about dates --
/// "no expiry" is not something to announce -- but still shows the fee and
/// term where the venue runs paid memberships.
class _Membership extends ConsumerWidget {
  const _Membership();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(meProvider).value ?? const <String, dynamic>{};
    final m = (me['membership'] as Map?) ?? const {};
    final expiry = m['expiry'] ?? me['membership_expiry'];
    final expired = m['expired'] == true;
    final term = (m['term_months'] as num?)?.toInt();
    final fee = (m['fee_minor'] as num?)?.toInt() ?? 0;
    final renewal = m['renewal_date'];
    final paid = fee > 0 || (term != null && term > 0);
    if (expiry == null && !paid) return const SizedBox.shrink();

    final theme = Theme.of(context);
    String howLong() {
      if (renewal != null) return 'Memberships run to ${when(renewal, time: false)} each year.';
      if (term != null && term > 0) return 'A membership lasts $term month${term == 1 ? '' : 's'}.';
      return '';
    }

    return SettingsCard(
      title: 'Membership',
      children: [
        if (expiry != null)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: Icon(expired ? Icons.event_busy : Icons.event_available, color: expired ? theme.colorScheme.error : null),
            title: Text(expired ? 'Ran out' : 'Runs until'),
            subtitle: Text(when(expiry, time: false)),
          )
        else
          const ListTile(
            contentPadding: EdgeInsets.zero,
            leading: Icon(Icons.event_available),
            title: Text('No end date on your membership'),
          ),
        if (paid)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.autorenew),
            title: Text(fee > 0 ? 'Renewing costs ${money(fee)}' : 'Renewing'),
            subtitle: howLong().isEmpty ? null : Text(howLong()),
          ),
        if (expired || expiry != null)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: FilledButton.tonalIcon(
              onPressed: () => _renew(context, fee: fee, term: term, renewal: renewal, expired: expired),
              icon: const Icon(Icons.autorenew),
              label: Text(expired ? 'Renew my membership' : 'Renew early'),
            ),
          ),
      ],
    );
  }

  /// What renewing means at this venue. The money is taken at the till --
  /// paying in the app is a question for the venue (see the plan) -- so this
  /// says so plainly rather than pretending to take a card.
  Future<void> _renew(BuildContext context, {required int fee, int? term, Object? renewal, required bool expired}) {
    final until = renewal != null
        ? 'to ${when(renewal, time: false)}'
        : term != null && term > 0
            ? 'for another $term month${term == 1 ? '' : 's'}'
            : '';
    return showDialog<void>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: const Text('Renewing your membership'),
        content: Text(
          '${fee > 0 ? 'It costs ${money(fee)}, ' : ''}'
          'paid at the till. Show your card and ask to renew; your membership then runs $until '
          'and your points ${expired ? 'can be spent again' : 'carry on as they are'}.',
        ),
        actions: [FilledButton(onPressed: () => Navigator.pop(dialog), child: const Text('Got it'))],
      ),
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
