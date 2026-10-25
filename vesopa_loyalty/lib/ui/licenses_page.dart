import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../data/venue_style.dart';

/// The open-source software in the app and its licences (owner, 2026-10-25).
///
/// Our own page rather than Flutter's showLicensePage: that one draws a
/// two-pane layout on an iPad whose heading ran into the club's bar, and marks
/// the chosen package in the theme's red, which did not read on the dark look.
/// Here it is one list, and each package opens on a page of its own.
class LicensesPage extends StatefulWidget {
  const LicensesPage({super.key, required this.appName, required this.version});

  final String appName;
  final String version;

  @override
  State<LicensesPage> createState() => _LicensesPageState();
}

class _LicensesPageState extends State<LicensesPage> {
  late final Future<Map<String, List<LicenseEntry>>> _byPackage = _load();

  static Future<Map<String, List<LicenseEntry>>> _load() async {
    final out = <String, List<LicenseEntry>>{};
    await for (final entry in LicenseRegistry.licenses) {
      for (final p in entry.packages) {
        (out[p] ??= []).add(entry);
      }
    }
    final keys = out.keys.toList()..sort((a, b) => a.toLowerCase().compareTo(b.toLowerCase()));
    return {for (final k in keys) k: out[k]!};
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: _bar(context, 'Open-source software'),
      body: SafeArea(
        child: FutureBuilder<Map<String, List<LicenseEntry>>>(
          future: _byPackage,
          builder: (context, snap) {
            final all = snap.data;
            if (all == null) return const Center(child: CircularProgressIndicator.adaptive());
            return Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 640),
                child: ListView.separated(
                  padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
                  itemCount: all.length + 1,
                  separatorBuilder: (_, i) => i == 0 ? const SizedBox(height: 12) : const Divider(height: 1),
                  itemBuilder: (context, i) {
                    if (i == 0) {
                      return Column(children: [
                        Text(widget.appName, style: theme.textTheme.titleLarge, textAlign: TextAlign.center),
                        if (widget.version.isNotEmpty) Text('Version ${widget.version}', textAlign: TextAlign.center),
                        Text('© ${DateTime.now().year} Vesopa Software Ltd', textAlign: TextAlign.center),
                        const SizedBox(height: 8),
                        Text(
                          '${all.length} open-source packages, with thanks to their authors.',
                          style: theme.textTheme.bodySmall,
                          textAlign: TextAlign.center,
                        ),
                      ]);
                    }
                    final name = all.keys.elementAt(i - 1);
                    final n = all[name]!.length;
                    return ListTile(
                      contentPadding: const EdgeInsets.symmetric(horizontal: 4),
                      title: Text(name),
                      subtitle: Text('$n licence${n == 1 ? '' : 's'}'),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(
                        builder: (_) => _LicenceText(name: name, entries: all[name]!),
                      )),
                    );
                  },
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}

PreferredSizeWidget _bar(BuildContext context, String title) {
  final theme = Theme.of(context);
  return AppBar(
    flexibleSpace: VenueStyle.enabled ? const ClubGradient(intensity: 0.6) : null,
    backgroundColor: VenueStyle.enabled ? Colors.transparent : null,
    foregroundColor: VenueStyle.enabled ? Colors.white : null,
    titleTextStyle: VenueStyle.enabled ? theme.appBarTheme.titleTextStyle?.copyWith(color: Colors.white) : null,
    title: Text(title, overflow: TextOverflow.ellipsis),
  );
}

class _LicenceText extends StatelessWidget {
  const _LicenceText({required this.name, required this.entries});

  final String name;
  final List<LicenseEntry> entries;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final blocks = <Widget>[];
    for (final e in entries) {
      if (blocks.isNotEmpty) blocks.add(const Divider(height: 32));
      for (final p in e.paragraphs) {
        blocks.add(Padding(
          padding: EdgeInsets.only(left: p.indent == LicenseParagraph.centeredIndent ? 0 : 12.0 * p.indent, bottom: 8),
          child: Text(
            p.text,
            textAlign: p.indent == LicenseParagraph.centeredIndent ? TextAlign.center : TextAlign.start,
            style: theme.textTheme.bodySmall?.copyWith(height: 1.45),
          ),
        ));
      }
    }
    return Scaffold(
      appBar: _bar(context, name),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 760),
            child: ListView(padding: const EdgeInsets.fromLTRB(20, 16, 20, 32), children: blocks),
          ),
        ),
      ),
    );
  }
}
