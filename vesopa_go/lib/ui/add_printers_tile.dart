/// Puts this venue's online printers on this phone, in one tap.
///
/// Apple lets no app install a printer by itself, so on an iPhone this opens the
/// venue's profile and the person confirms it in Settings. Android has no way to
/// add a printer by a web address, so there it opens a printer's page, which
/// installs into the Share menu.
library;

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../data/api.dart';
import '../data/session.dart';

class AddPrintersTile extends ConsumerWidget {
  const AddPrintersTile({super.key});

  Future<void> _add(BuildContext context, WidgetRef ref) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      final link = await ref.read(apiProvider).printProfileLink();
      final drives = link['drives'] as List<dynamic>? ?? const [];
      if (drives.isEmpty) {
        messenger.showSnackBar(const SnackBar(content: Text('This venue has no online printers yet.')));
        return;
      }
      if (Platform.isIOS) {
        await launchUrl(Uri.parse(link['url'] as String), mode: LaunchMode.externalApplication);
        messenger.showSnackBar(const SnackBar(
          content: Text('Tap Allow, then open Settings and install the profile.'),
          duration: Duration(seconds: 8),
        ));
        return;
      }
      if (!context.mounted) return;
      await showModalBottomSheet<void>(
        context: context,
        showDragHandle: true,
        builder: (c) => ListView(shrinkWrap: true, children: [
          const ListTile(subtitle: Text('Open a printer, then choose Install app in the browser menu. It then appears when you share a document.')),
          for (final d in drives)
            ListTile(
              leading: const Icon(Icons.print_rounded),
              title: Text('${(d as Map)['name']}'),
              trailing: const Icon(Icons.open_in_new_rounded),
              onTap: () => launchUrl(Uri.parse('${d['url']}'), mode: LaunchMode.externalApplication),
            ),
        ]),
      );
    } on TapApiError catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) => Card(
    child: ListTile(
      leading: const Icon(Icons.print_rounded),
      title: const Text("Add this venue's printers"),
      subtitle: const Text('Print to them from any app, from anywhere.'),
      trailing: const Icon(Icons.chevron_right_rounded),
      onTap: () => _add(context, ref),
    ),
  );
}
