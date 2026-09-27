import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../brand.dart';
import '../data/api.dart';
import '../data/session.dart';
import 'widgets.dart';

/// The member's own details, where the membership works, help, sign out and
/// deleting the account.
class AccountPage extends ConsumerWidget {
  const AccountPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final account = ref.watch(accountProvider);
    final sites = ref.watch(sitesProvider);
    final log = ref.read(activityLogProvider);
    return account.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => ErrorNotice(e.toString(), onRetry: () => ref.invalidate(accountProvider)),
      data: (a) => ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
        children: [
          PageHero(
            icon: Icons.person_rounded,
            overline: 'Your account',
            title: a.member.name.isEmpty ? 'Your account' : a.member.name,
            subtitle: '${a.member.email}\nMember ${a.member.memberNo}',
          ),
          const SizedBox(height: 22),
          const SectionTitle('Your details'),
          Card(
            child: Column(
              children: [
                ListTile(leading: const IconTile(Icons.badge_outlined), title: const Text('Name'), subtitle: Text(a.member.name.isEmpty ? 'Not set' : a.member.name)),
                ListTile(leading: const IconTile(Icons.alternate_email_rounded), title: const Text('Email'), subtitle: Text(a.member.email)),
                ListTile(leading: const IconTile(Icons.phone_iphone_rounded), title: const Text('Phone'), subtitle: Text(a.member.phone.isEmpty ? 'Not set' : a.member.phone)),
                ListTile(leading: const IconTile(Icons.business_rounded), title: const Text('Company'), subtitle: Text(a.member.company.isEmpty ? 'Not set' : a.member.company)),
                ListTile(leading: const IconTile(Icons.qr_code_2_rounded), title: const Text('Member number'), subtitle: Text(a.member.memberNo)),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: OutlinedButton.icon(
                      icon: const Icon(Icons.edit),
                      label: const Text('Edit my details'),
                      onPressed: () {
                        log.tap('edit_details');
                        showDialog<void>(context: context, builder: (_) => _EditDetails(member: a.member));
                      },
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
          const SectionTitle('Where it works'),
          sites.when(
            loading: () => const LinearProgressIndicator(),
            error: (_, _) => const Text('Could not load the sites.'),
            data: (list) => Card(
              child: Column(
                children: list.isEmpty
                    ? [const ListTile(title: Text('Metric will list your car parks here.'))]
                    : [for (final s in list) ListTile(leading: const IconTile(Icons.local_parking), title: Text(s.name), subtitle: s.address.isEmpty ? null : Text(s.address))],
              ),
            ),
          ),
          const SizedBox(height: 20),
          const SectionTitle('Help'),
          Card(
            child: Column(
              children: [
                ListTile(
                  leading: const IconTile(Icons.phone),
                  title: const Text('Call Metric'),
                  subtitle: const Text(MetricBrand.phone),
                  onTap: () {
                    log.tap('call_metric');
                    launchUrl(Uri.parse('tel:${MetricBrand.phone.replaceAll(' ', '')}'));
                  },
                ),
                ListTile(
                  leading: const IconTile(Icons.build),
                  title: const Text('Barrier not opening?'),
                  subtitle: const Text('Service line ${MetricBrand.servicePhone}. Check the plate on your car matches the one here, and that it is clean.'),
                  onTap: () {
                    log.tap('call_service');
                    launchUrl(Uri.parse('tel:${MetricBrand.servicePhone.replaceAll(' ', '')}'));
                  },
                ),
                ListTile(
                  leading: const IconTile(Icons.public),
                  title: const Text('metricgroup.co.uk'),
                  onTap: () {
                    log.tap('open_website');
                    launchUrl(Uri.parse(MetricBrand.website), mode: LaunchMode.externalApplication);
                  },
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
          OutlinedButton.icon(
            key: const Key('sign-out'),
            icon: const Icon(Icons.logout),
            label: const Text('Sign out'),
            onPressed: () {
              log.tap('sign_out');
              ref.read(sessionProvider.notifier).signOut();
            },
          ),
          const SizedBox(height: 8),
          TextButton(
            style: TextButton.styleFrom(foregroundColor: MetricBrand.red),
            onPressed: () => _delete(context, ref),
            child: const Text('Delete my account'),
          ),
          const SizedBox(height: 16),
          Text('Metric Membership ${AppConfig.version} · powered by Vesopa', textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodySmall),
        ],
      ),
    );
  }

  Future<void> _delete(BuildContext context, WidgetRef ref) async {
    final log = ref.read(activityLogProvider);
    log.tap('delete_account');
    final sure = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Delete your account?'),
        content: const Text('Your membership closes and the barriers stop opening for all your cars straight away. Your Vesopa account itself is not deleted.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Keep it')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: MetricBrand.red),
            onPressed: () => Navigator.pop(c, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (sure != true) return;
    try {
      await ref.read(apiProvider).deleteAccount();
      await ref.read(sessionProvider.notifier).signOut();
    } on ApiError catch (e) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }
}

class _EditDetails extends ConsumerStatefulWidget {
  const _EditDetails({required this.member});

  final Member member;

  @override
  ConsumerState<_EditDetails> createState() => _EditDetailsState();
}

class _EditDetailsState extends ConsumerState<_EditDetails> {
  late final _name = TextEditingController(text: widget.member.name);
  late final _phone = TextEditingController(text: widget.member.phone);
  late final _company = TextEditingController(text: widget.member.company);
  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    _company.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Your details'),
    content: SizedBox(
      width: 380,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(controller: _name, decoration: const InputDecoration(labelText: 'Name')),
          const SizedBox(height: 12),
          TextField(controller: _phone, keyboardType: TextInputType.phone, decoration: const InputDecoration(labelText: 'Phone')),
          const SizedBox(height: 12),
          TextField(controller: _company, decoration: const InputDecoration(labelText: 'Company (optional)')),
        ],
      ),
    ),
    actions: [
      TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
      FilledButton(
        onPressed: _busy
            ? null
            : () async {
                ref.read(activityLogProvider).tap('save_details');
                setState(() => _busy = true);
                try {
                  await ref.read(apiProvider).updateMe(name: _name.text.trim(), phone: _phone.text.trim(), company: _company.text.trim());
                  ref.invalidate(accountProvider);
                  if (context.mounted) Navigator.pop(context);
                } on ApiError catch (e) {
                  setState(() => _busy = false);
                  if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
                }
              },
        child: const Text('Save'),
      ),
    ],
  );
}
