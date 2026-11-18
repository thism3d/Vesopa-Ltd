/// Scan and connect: both halves.
///
/// [LinkScreenPage] is what a new screen shows: a QR and a short code, and
/// nothing to type. A television has no browser to sign in with, and a remote
/// is no way to enter a venue code, a number and an access key (the owner,
/// 2026-11-16). It works on a phone or tablet too, for a device a manager
/// would rather not sign in on.
///
/// [connectScreen] is the other half, on a device that is already in the
/// venue: scan the screen's QR (or type its code), say what the screen is for,
/// and it is let in. The same code can be typed on Terminals in the back
/// office.
///
/// The server keeps the two apart with a secret only the new screen holds
/// (vesopa_server src/terminal_licences.js, "Scan and connect").
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../data/api.dart';
import '../../data/session.dart';
import '../../config/constants.dart' show goAppVersion;
import '../theme.dart';
import '../tv.dart';
import 'scan_sheet.dart';

/// What a screen was let in as, kept until the setup page has opened it there.
const linkedModeKey = 'go_linked_mode';

/// The code as it is read aloud: two groups of four.
String spokenLinkCode(String code) => code.length == 8 ? '${code.substring(0, 4)} ${code.substring(4)}' : code;

/// The code out of whatever was scanned or typed: the QR's link, or the
/// letters themselves with or without the space.
String? linkCodeFrom(String scanned) {
  final text = scanned.trim();
  final uri = Uri.tryParse(text);
  final fromLink = uri != null && uri.hasQuery ? uri.queryParameters['c'] : null;
  final code = (fromLink ?? text).toUpperCase().replaceAll(RegExp('[^A-Z0-9]'), '');
  return code.length == 8 ? code : null;
}

class LinkScreenPage extends ConsumerStatefulWidget {
  const LinkScreenPage({super.key});

  @override
  ConsumerState<LinkScreenPage> createState() => _LinkScreenPageState();
}

class _LinkScreenPageState extends ConsumerState<LinkScreenPage> {
  String? _code;
  String? _secret;
  String? _url;
  String? _error;
  bool _joining = false;
  Timer? _poll;
  Timer? _renew;

  @override
  void initState() {
    super.initState();
    unawaited(_start());
  }

  @override
  void dispose() {
    _poll?.cancel();
    _renew?.cancel();
    super.dispose();
  }

  Future<void> _start() async {
    _poll?.cancel();
    _renew?.cancel();
    setState(() {
      _error = null;
      _code = null;
    });
    try {
      final session = ref.read(tapProvider.notifier);
      final r = await ref.read(apiProvider).linkStart(device: session.terminalName, version: goAppVersion, tv: GoDevice.isTv);
      if (!mounted) return;
      setState(() {
        _code = r['code'] as String?;
        _secret = r['secret'] as String?;
        _url = r['url'] as String?;
      });
      final life = ((r['expires_in'] as num?)?.toInt() ?? 600) - 20;
      // A fresh code before this one runs out, so a screen left on a wall
      // overnight is still showing one that works.
      _renew = Timer(Duration(seconds: life.clamp(60, 3600)), () => unawaited(_start()));
      _poll = Timer.periodic(const Duration(seconds: 3), (_) => unawaited(_check()));
    } on TapApiError catch (e) {
      if (!mounted) return;
      setState(() => _error = e.message);
      _renew = Timer(const Duration(seconds: 15), () => unawaited(_start()));
    }
  }

  Future<void> _check() async {
    final code = _code, secret = _secret;
    if (code == null || secret == null || _joining) return;
    Map<String, dynamic> r;
    try {
      r = await ref.read(apiProvider).linkPoll(code, secret);
    } on TapApiError catch (e) {
      // Run out, or the server restarted: ask again. No signal: keep waiting.
      if (e.status == 404 && mounted) unawaited(_start());
      return;
    }
    if (r['status'] != 'approved' || !mounted) return;
    _poll?.cancel();
    _renew?.cancel();
    setState(() => _joining = true);
    try {
      final session = ref.read(tapProvider.notifier);
      // What it was let in as, before the venue loads, so it opens there.
      final mode = '${r['mode'] ?? ''}';
      if (mode.isNotEmpty) {
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString(linkedModeKey, mode);
      }
      final done = await ref.read(apiProvider).licenseWithKey(
            venueCode: '${r['venue_code']}',
            terminalNumber: '${r['terminal_number']}',
            accessKey: '${r['access_key']}',
            device: session.terminalName,
            deviceId: session.deviceId,
            version: goAppVersion,
          );
      await session.commissioned(done);
      if (mounted) Navigator.of(context).popUntil((route) => route.isFirst);
    } on TapApiError catch (e) {
      if (!mounted) return;
      setState(() {
        _joining = false;
        _error = e.message;
      });
      unawaited(_start());
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final code = _code;
    final steps = Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      Text('Connect this screen', style: t.headlineMedium?.copyWith(fontWeight: FontWeight.w900, letterSpacing: -0.6)),
      const SizedBox(height: 10),
      Text('Use a phone or tablet that is already signed in to your venue.', style: t.titleMedium?.copyWith(color: context.goMuted, height: 1.35)),
      const SizedBox(height: 22),
      const _Step(1, 'Point your phone\'s camera at this code. Vesopa Go opens by itself.'),
      const _Step(2, 'Or in Vesopa Go: Settings, Connect a screen or TV, and scan it.'),
      const _Step(3, 'Choose what this screen is for. It opens a few seconds later.'),
      const SizedBox(height: 18),
      Text('No phone to hand? Type the code on Terminals in the back office.', style: t.bodyMedium?.copyWith(color: context.goMuted)),
      if (_error != null) ...[
        const SizedBox(height: 14),
        Text(_error!, style: t.bodyMedium?.copyWith(color: Tp.danger)),
      ],
      if (!GoDevice.isTv) ...[
        const SizedBox(height: 20),
        OutlinedButton.icon(
          onPressed: () => Navigator.of(context).maybePop(),
          icon: const Icon(Icons.arrow_back_rounded),
          label: const Text('Sign in instead'),
        ),
      ],
    ]);
    final card = Container(
      padding: const EdgeInsets.all(22),
      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(28)),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        if (_joining)
          const SizedBox(width: 260, height: 260, child: Center(child: CircularProgressIndicator()))
        else if (code == null || _url == null)
          SizedBox(
            width: 260,
            height: 260,
            child: Center(child: _error == null ? const CircularProgressIndicator() : const Icon(Icons.wifi_off_rounded, size: 56, color: Tp.ink)),
          )
        else
          QrImageView(data: _url!, size: 260, padding: EdgeInsets.zero, semanticsLabel: 'Code to connect this screen'),
        const SizedBox(height: 16),
        Text(
          _joining ? 'Connecting' : (code == null ? (_error == null ? 'Getting a code' : 'No connection') : spokenLinkCode(code)),
          style: t.headlineMedium?.copyWith(color: Tp.ink, fontWeight: FontWeight.w900, letterSpacing: code == null ? 0 : 4, fontFeatures: Tp.tabular),
        ),
      ]),
    );
    return Scaffold(
      body: SafeArea(
        child: LayoutBuilder(builder: (context, box) {
          final wide = box.maxWidth >= 760 && box.maxWidth > box.maxHeight;
          return Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(28),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 1040),
                child: wide
                    ? Row(children: [Expanded(child: steps), const SizedBox(width: 40), card])
                    : Column(mainAxisSize: MainAxisSize.min, children: [card, const SizedBox(height: 28), steps]),
              ),
            ),
          );
        }),
      ),
    );
  }
}

class _Step extends StatelessWidget {
  const _Step(this.number, this.words);
  final int number;
  final String words;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Container(
            width: 30,
            height: 30,
            alignment: Alignment.center,
            decoration: BoxDecoration(color: Tp.lime, shape: BoxShape.circle),
            child: Text('$number', style: TextStyle(color: Tp.onLime, fontWeight: FontWeight.w900)),
          ),
          const SizedBox(width: 12),
          Expanded(child: Padding(padding: const EdgeInsets.only(top: 3), child: Text(words, style: Theme.of(context).textTheme.titleMedium))),
        ]),
      );
}

/// What a newly connected screen can be.
const linkModes = <(String, String, String, IconData)>[
  ('display', 'Customer display', 'The bill, adverts and how to pay.', Icons.connected_tv_rounded),
  ('kitchen', 'Kitchen screen', 'Tickets for the kitchen or the bar.', Icons.soup_kitchen_rounded),
  ('epos', 'Till', 'Orders and payments.', Icons.point_of_sale_rounded),
  ('terminal', 'Card terminal', 'Takes card payments sent from a till.', Icons.contactless_rounded),
];

/// From a device already in the venue: let a new screen in.
Future<void> connectScreen(BuildContext context, WidgetRef ref) async {
  final scanned = await scanCode(context, title: 'Connect a screen', hint: 'Scan the code on the new screen, or type it');
  if (scanned == null || !context.mounted) return;
  final code = linkCodeFrom(scanned);
  if (code == null) {
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('That is not a screen\'s code. It is eight letters and numbers.')));
    return;
  }
  await connectScreenCode(context, ref, code);
}

/// A screen's code, scanned in the app or opened from its QR with the
/// phone's camera (go.vesopa.com/link/?c=..., a universal link; owner,
/// 2026-11-18): the screen's own name, what it is for, and a clear answer.
Future<void> connectScreenCode(BuildContext context, WidgetRef ref, String code) async {
  final api = ref.read(apiProvider);
  Map<String, dynamic>? info;
  String? problem;
  try {
    info = await api.linkInfo(code);
  } on TapApiError catch (e) {
    problem = e.message;
  }
  if (!context.mounted) return;
  if (info == null) {
    await _connectAnswer(context, ok: false, title: 'Could not connect', words: problem ?? 'That code is not on a screen now.');
    return;
  }
  final name = '${info['name'] ?? 'Screen'}';
  final tv = info['tv'] == true;
  final mode = await showModalBottomSheet<String>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (sheet) {
      final t = Theme.of(sheet).textTheme;
      return SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(8, 0, 8, 12),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
              child: Row(children: [
                Container(
                  width: 56,
                  height: 56,
                  decoration: BoxDecoration(color: sheet.goLimeInk.withValues(alpha: 0.15), borderRadius: BorderRadius.circular(16)),
                  child: Icon(tv ? Icons.tv_rounded : Icons.tablet_mac_rounded, color: sheet.goLimeInk, size: 30),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('Connect $name?', style: t.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
                    Text('${tv ? 'TV' : 'Screen'} · code ${spokenLinkCode(code)}', style: t.bodyMedium?.copyWith(color: sheet.goMuted)),
                  ]),
                ),
              ]),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 4),
              child: Text('What is it for?', style: t.titleSmall?.copyWith(color: sheet.goMuted)),
            ),
            for (final (key, label, detail, icon) in linkModes)
              if (!(tv && key == 'terminal'))
                ListTile(
                  leading: Icon(icon),
                  title: Text(label, style: const TextStyle(fontWeight: FontWeight.w700)),
                  subtitle: Text(detail),
                  trailing: const Icon(Icons.chevron_right_rounded),
                  onTap: () => Navigator.pop(sheet, key),
                ),
          ]),
        ),
      );
    },
  );
  if (mode == null || !context.mounted) return;
  try {
    final r = await api.linkApprove(code, mode: mode, name: name);
    unawaited(HapticFeedback.mediumImpact());
    if (!context.mounted) return;
    final label = linkModes.firstWhere((m) => m.$1 == mode).$2.toLowerCase();
    await _connectAnswer(context,
        ok: true,
        title: '$name is connected',
        words: 'It opens as a $label for ${r['venue'] ?? 'your venue'} in a few seconds.');
  } on TapApiError catch (e) {
    if (context.mounted) await _connectAnswer(context, ok: false, title: 'Could not connect $name', words: e.message);
  }
}

Future<void> _connectAnswer(BuildContext context, {required bool ok, required String title, required String words}) => showDialog<void>(
      context: context,
      builder: (c) => AlertDialog(
        icon: Icon(ok ? Icons.check_circle_rounded : Icons.error_outline_rounded, size: 48, color: ok ? Tp.green : Tp.danger),
        title: Text(title, textAlign: TextAlign.center),
        content: Text(words, textAlign: TextAlign.center),
        actions: [FilledButton(onPressed: () => Navigator.pop(c), child: const Text('OK'))],
      ),
    );
