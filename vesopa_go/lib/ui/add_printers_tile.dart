/// Puts this venue's online printers on this phone, one step at a time.
///
/// Apple lets no app install a printer by itself, so on an iPhone this fetches
/// the venue's signed profile and walks the person through confirming it in
/// Settings. Android has no way to add a printer by a web address, so there it
/// opens a printer's page, which installs into the Share menu.
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
        messenger.showSnackBar(const SnackBar(content: Text('This venue has no online printers yet. Create one in the back office, under Virtual Printers.')));
        return;
      }
      if (!context.mounted) return;
      await showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        showDragHandle: true,
        builder: (_) => SafeArea(
          child: Platform.isIOS ? _AppleSteps(drives: drives, url: link['url'] as String) : _AndroidPrinters(drives: drives),
        ),
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

class _AppleSteps extends StatefulWidget {
  const _AppleSteps({required this.drives, required this.url});

  final List<dynamic> drives;
  final String url;

  @override
  State<_AppleSteps> createState() => _AppleStepsState();
}

class _AppleStepsState extends State<_AppleSteps> {
  int _step = 0;

  Future<void> _download() async {
    await launchUrl(Uri.parse(widget.url), mode: LaunchMode.externalApplication);
    if (mounted) setState(() => _step = 1);
  }

  Future<void> _settings() async {
    // The nearest an app may go: Settings itself. Apple has no way in to the profile.
    await launchUrl(Uri.parse('app-settings:'), mode: LaunchMode.externalApplication);
  }

  Widget _row(int index, String title, String body, {String? action, VoidCallback? onTap}) {
    final done = _step > index;
    final now = _step == index;
    return Opacity(
      opacity: now ? 1 : 0.55,
      child: ListTile(
        leading: CircleAvatar(radius: 14, child: done ? const Icon(Icons.check_rounded, size: 16) : Text('${index + 1}')),
        title: Text(title),
        subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(body),
          if (now && action != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: FilledButton(onPressed: onTap, child: Text(action)),
            ),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final names = widget.drives.map((d) => '${(d as Map)['name']}').join(', ');
    return SingleChildScrollView(
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        ListTile(title: const Text('Add printers to this device'), subtitle: Text(names)),
        _row(0, 'Download the printers', 'It opens in Safari. Tap Allow, then come back here.', action: 'Download', onTap: _download),
        _row(1, 'Install in Settings', 'In Settings, tap Profile Downloaded near the top, then Install. If you land on Vesopa Go\'s page, tap Settings first to go back.', action: 'Open Settings', onTap: _settings),
        if (_step == 1)
          Padding(
            padding: const EdgeInsets.fromLTRB(72, 0, 16, 8),
            child: TextButton(onPressed: () => setState(() => _step = 2), child: const Text('I have installed it')),
          ),
        _row(2, 'Print', 'In any app choose Print, then Printer, and pick a Vesopa printer. It works on any connection.', action: 'Done', onTap: () => Navigator.of(context).pop()),
        const SizedBox(height: 8),
      ]),
    );
  }
}

class _AndroidPrinters extends StatelessWidget {
  const _AndroidPrinters({required this.drives});

  final List<dynamic> drives;

  @override
  Widget build(BuildContext context) => ListView(shrinkWrap: true, children: [
    const ListTile(
      title: Text('Add a printer to this phone'),
      subtitle: Text('Open a printer and tap Add to this phone. It then appears when you tap Share on a document.'),
    ),
    for (final d in drives)
      ListTile(
        leading: const Icon(Icons.print_rounded),
        title: Text('${(d as Map)['name']}'),
        trailing: const Icon(Icons.open_in_new_rounded),
        onTap: () => launchUrl(Uri.parse('${d['url']}'), mode: LaunchMode.externalApplication),
      ),
  ]);
}
