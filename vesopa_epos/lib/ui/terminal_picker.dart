import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/constants.dart' show VesopaBrand;
import '../data/terminal_number.dart';
import '../main.dart' show apiBaseProvider;
import 'widgets/pos_message.dart';

/// Ask once, after a sign-in, which of the venue's terminals this till is.
///
/// A till licensed with a venue code and terminal number already knows; a
/// till signed in with an email or a Vesopa account is asked here. "Later"
/// asks again the next time the till starts. See data/terminal_number.dart.
Future<void> askTerminalNumberIfNeeded(BuildContext context, WidgetRef ref) async {
  final number = await ref.read(terminalNumberProvider.future);
  if (number != null || !context.mounted) return;
  await showTerminalPicker(context, ref);
}

/// The venue's terminals and "New terminal". True when one was chosen.
Future<bool> showTerminalPicker(BuildContext context, WidgetRef ref) async {
  final chosen = await showDialog<bool>(
    context: context,
    barrierDismissible: false,
    builder: (_) => const _TerminalPicker(),
  );
  return chosen ?? false;
}

class _TerminalPicker extends ConsumerStatefulWidget {
  const _TerminalPicker();
  @override
  ConsumerState<_TerminalPicker> createState() => _TerminalPickerState();
}

class _TerminalPickerState extends ConsumerState<_TerminalPicker> {
  List<VenueTerminal>? _terminals;
  bool _loading = true;
  bool _saving = false;
  String? _error;

  /// The number picked, or 0 for a new terminal.
  int? _pick;
  final _name = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final list = await venueTerminals(ref.read(apiBaseProvider));
    if (!mounted) return;
    setState(() {
      _terminals = list;
      _loading = false;
      final mine = list.where((t) => t.mine).toList();
      _pick ??= mine.isNotEmpty ? mine.first.number : (list.isEmpty ? 0 : null);
    });
  }

  int get _nextNumber =>
      (_terminals ?? const []).fold<int>(0, (m, t) => t.number > m ? t.number : m) + 1;

  Future<void> _save({bool confirm = false}) async {
    final pick = _pick;
    if (pick == null) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final t = await claimTerminal(
        ref,
        apiBase: ref.read(apiBaseProvider),
        version: VesopaBrand.appVersion,
        number: pick == 0 ? null : pick,
        name: pick == 0 ? _name.text : null,
        confirm: confirm,
      );
      if (!mounted) return;
      Navigator.pop(context, true);
      PosMessenger.success(context, 'This till is ${t.label}.');
    } on TerminalClaimFailed catch (e) {
      if (!mounted) return;
      if (e.busy && !confirm) {
        setState(() => _saving = false);
        final yes = await showDialog<bool>(
          context: context,
          builder: (c) => AlertDialog(
            icon: const Icon(Icons.swap_horiz_rounded, size: 34),
            title: const Text('Replace that till?'),
            content: Text(e.message),
            actions: [
              TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Choose another')),
              FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Replace it')),
            ],
          ),
        );
        if (yes == true && mounted) await _save(confirm: true);
        return;
      }
      setState(() {
        _saving = false;
        _error = e.message;
      });
    }
  }

  static String _ago(DateTime? at) {
    if (at == null) return 'not seen yet';
    final d = DateTime.now().difference(at);
    if (d.inMinutes < 2) return 'in use now';
    if (d.inHours < 1) return '${d.inMinutes} minutes ago';
    if (d.inDays < 1) return '${d.inHours} hour${d.inHours == 1 ? '' : 's'} ago';
    if (d.inDays < 60) return '${d.inDays} day${d.inDays == 1 ? '' : 's'} ago';
    return '${at.day}/${at.month}/${at.year}';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final list = _terminals ?? const <VenueTerminal>[];

    Widget option({
      required int value,
      required Widget badge,
      required String title,
      String? subtitle,
      Widget? extra,
    }) {
      final on = _pick == value;
      return Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Material(
          color: on ? scheme.primary.withValues(alpha: 0.14) : scheme.surfaceContainerHighest.withValues(alpha: 0.5),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
            side: BorderSide(color: on ? scheme.primary : Colors.transparent, width: 2),
          ),
          child: InkWell(
            borderRadius: BorderRadius.circular(14),
            onTap: _saving ? null : () => setState(() => _pick = value),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Row(children: [
                  badge,
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(title, style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                      if (subtitle != null)
                        Text(subtitle, style: theme.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant)),
                    ]),
                  ),
                  Icon(on ? Icons.radio_button_checked : Icons.radio_button_off,
                      color: on ? scheme.primary : scheme.outline),
                ]),
                if (on && extra != null) ...[const SizedBox(height: 10), extra],
              ]),
            ),
          ),
        ),
      );
    }

    Widget number(String text, {bool add = false}) => Container(
          width: 44,
          height: 44,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: add ? scheme.surface : scheme.primary,
            borderRadius: BorderRadius.circular(12),
            border: add ? Border.all(color: scheme.outline) : null,
          ),
          child: add
              ? Icon(Icons.add_rounded, color: scheme.onSurface)
              : Text(text,
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: scheme.onPrimary)),
        );

    return AlertDialog(
      icon: const Icon(Icons.point_of_sale_rounded, size: 36),
      title: const Text('Which terminal is this till?'),
      content: SizedBox(
        width: 480,
        child: _loading
            ? const SizedBox(height: 160, child: Center(child: CircularProgressIndicator()))
            : Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Text(
                  'Pick the till this machine replaces, or add a new one. Its sales, '
                  'X and Z reports carry on under that terminal, and its printers '
                  'and settings come with it.',
                  style: theme.textTheme.bodyMedium?.copyWith(color: scheme.onSurfaceVariant),
                ),
                const SizedBox(height: 14),
                Flexible(
                  child: SingleChildScrollView(
                    child: Column(children: [
                      for (final t in list)
                        option(
                          value: t.number,
                          badge: number('${t.number}'),
                          title: t.label,
                          subtitle: t.mine
                              ? 'This machine'
                              : 'Last on ${t.deviceName ?? 'another machine'} · ${_ago(t.lastSeen)}',
                        ),
                      option(
                        value: 0,
                        badge: number('', add: true),
                        title: 'New terminal',
                        subtitle: 'Terminal $_nextNumber',
                        extra: TextField(
                          controller: _name,
                          autofocus: false,
                          textCapitalization: TextCapitalization.words,
                          decoration: const InputDecoration(
                            labelText: 'Name (optional)',
                            hintText: 'Bar, Lounge, Patio…',
                          ),
                        ),
                      ),
                    ]),
                  ),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 8),
                  Text(_error!, style: TextStyle(color: scheme.error, fontWeight: FontWeight.w600)),
                ],
              ]),
      ),
      actions: [
        TextButton(
          onPressed: _saving ? null : () => Navigator.pop(context, false),
          child: const Text('Later'),
        ),
        if (!_loading && list.isEmpty)
          TextButton(onPressed: _saving ? null : _load, child: const Text('Refresh')),
        FilledButton(
          onPressed: _saving || _loading || _pick == null ? null : () => _save(),
          child: _saving
              ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : const Text('Use this terminal'),
        ),
      ],
    );
  }
}
