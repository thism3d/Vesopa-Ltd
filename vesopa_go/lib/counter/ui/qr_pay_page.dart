/// QR Pay (owner, 2026-11-02): the customer scans a code and pays the bill on
/// their own phone, by card, Apple Pay or Google Pay, on Dojo's checkout at
/// the venue's menu address (server qr_pay.js). The answer comes over the
/// venue's websocket the moment the server has it, with a poll behind it, and
/// counts only once Dojo says captured.
///
/// The clerk can also send the link: the phone's own share sheet (AirDrop and
/// NameDrop on an iPhone, Nearby Share on Android, messages, mail) or an
/// email straight to the customer, prefilled for a member.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:share_plus/share_plus.dart';
import 'package:uuid/uuid.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../../data/api.dart';
import '../../data/models.dart';
import '../../data/session.dart';
import '../../ui/pay_motion.dart';
import '../../ui/theme.dart';

/// What came of a QR payment: the Dojo intent when it was paid, else null.
typedef QrPaid = ({String intentId, int amountMinor});

/// The QR Pay screen for [amountMinor] of [bill]. Answers when paid.
Future<QrPaid?> showQrPay(
  BuildContext context, {
  required Bill bill,
  required int amountMinor,
  String? customerName,
  String? customerEmail,
}) =>
    Navigator.of(context).push<QrPaid>(MaterialPageRoute(
      fullscreenDialog: true,
      // Dark for the customer, in the venue's own lettering.
      builder: (_) => Theme(
        data: Tp.theme(Brightness.dark, font: Theme.of(context).textTheme.bodyMedium?.fontFamily),
        child: QrPayPage(bill: bill, amountMinor: amountMinor, customerName: customerName, customerEmail: customerEmail),
      ),
    ));

class QrPayPage extends ConsumerStatefulWidget {
  const QrPayPage({super.key, required this.bill, required this.amountMinor, this.customerName, this.customerEmail});
  final Bill bill;
  final int amountMinor;
  final String? customerName;
  final String? customerEmail;

  @override
  ConsumerState<QrPayPage> createState() => _QrPayPageState();
}

class _QrPayPageState extends ConsumerState<QrPayPage> {
  final String _id = 'qr-${const Uuid().v4().replaceAll('-', '')}';
  Map<String, dynamic>? _payment;
  String? _problem;
  bool _closing = false;
  Timer? _poll;
  WebSocketChannel? _socket;
  StreamSubscription<dynamic>? _socketSub;

  String get _status => '${_payment?['status'] ?? 'starting'}';
  String? get _url => _payment?['url'] as String?;

  @override
  void initState() {
    super.initState();
    _start();
  }

  @override
  void dispose() {
    _poll?.cancel();
    _socketSub?.cancel();
    _socket?.sink.close();
    super.dispose();
  }

  Future<void> _start() async {
    setState(() => _problem = null);
    try {
      final p = await ref.read(apiProvider).qrCreate(
            id: _id,
            amountMinor: widget.amountMinor,
            billRef: widget.bill.id,
            billName: widget.bill.name,
            customerName: widget.customerName,
          );
      if (!mounted) return;
      setState(() => _payment = p);
      _listen();
      _poll = Timer.periodic(const Duration(seconds: 3), (_) => _check());
    } on TapApiError catch (e) {
      // 404: the back office has no QR Pay yet (an older server).
      if (mounted) setState(() => _problem = e.status == 404 ? "QR Pay is not on this venue's back office yet. Use Card or Cash for now." : e.message);
    }
  }

  /// The venue's websocket: Dojo's answer arrives here first.
  void _listen() {
    final api = ref.read(apiProvider);
    final office = api.office;
    if (office == null || office.isEmpty) return;
    try {
      final base = Uri.parse(api.base);
      final ch = WebSocketChannel.connect(base.replace(scheme: base.scheme == 'https' ? 'wss' : 'ws', path: '/ws'));
      _socket = ch;
      ch.sink.add(jsonEncode({'type': 'subscribe', 'office': office}));
      _socketSub = ch.stream.listen((raw) {
        try {
          final m = jsonDecode(raw is String ? raw : utf8.decode(raw as List<int>)) as Map;
          if (m['type'] == 'qrpay.updated' && m['id'] == _id) _check();
        } catch (_) {}
      }, onError: (Object _) {}, cancelOnError: true);
    } catch (_) {
      // The poll carries on without it.
    }
  }

  Future<void> _check() async {
    if (_closing || _payment == null) return;
    try {
      final p = await ref.read(apiProvider).qrStatus(_id);
      if (!mounted) return;
      setState(() => _payment = p);
      if (p['status'] == 'paid') _paid();
      if (p['status'] != 'waiting' && p['status'] != 'paid') _poll?.cancel();
    } on TapApiError {
      // Asked again on the next tick.
    }
  }

  void _paid() {
    if (_closing) return;
    _closing = true;
    _poll?.cancel();
    HapticFeedback.heavyImpact();
    final intent = '${_payment?['intent_id'] ?? _id}';
    Future<void>.delayed(const Duration(milliseconds: 1400), () {
      if (mounted) Navigator.of(context).pop<QrPaid>((intentId: intent, amountMinor: widget.amountMinor));
    });
  }

  Future<void> _cancel() async {
    if (_payment == null || _status != 'waiting') {
      Navigator.of(context).pop();
      return;
    }
    try {
      final p = await ref.read(apiProvider).qrCancel(_id);
      if (!mounted) return;
      setState(() => _payment = p);
      // Paid as the clerk pressed Cancel: that customer has paid.
      if (p['status'] == 'paid') return _paid();
      Navigator.of(context).pop();
    } on TapApiError catch (e) {
      if (mounted) setState(() => _problem = e.message);
    }
  }

  Future<void> _share(BuildContext anchor) async {
    final url = _url;
    if (url == null) return;
    final box = anchor.findRenderObject() as RenderBox?;
    await SharePlus.instance.share(ShareParams(
      uri: Uri.parse(url),
      subject: 'Pay your bill: ${money(widget.amountMinor)}',
      sharePositionOrigin: box == null ? null : box.localToGlobal(Offset.zero) & box.size,
    ));
  }

  Future<void> _email() async {
    final controller = TextEditingController(text: widget.customerEmail ?? '');
    final to = await showDialog<String>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Email the pay link'),
        content: TextField(
          controller: controller,
          autofocus: true,
          keyboardType: TextInputType.emailAddress,
          decoration: const InputDecoration(labelText: 'Customer\'s email'),
          onSubmitted: (v) => Navigator.pop(c, v.trim()),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, controller.text.trim()), child: const Text('Send')),
        ],
      ),
    );
    if (to == null || to.isEmpty || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(apiProvider).qrEmail(_id, to);
      messenger.showSnackBar(SnackBar(content: Text('Pay link sent to $to')));
    } on TapApiError catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final config = ref.watch(tapProvider.select((s) => s.config));
    final venue = ref.watch(tapProvider.select((s) => s.venue?.name)) ?? '';
    final wide = MediaQuery.sizeOf(context).width >= 760;
    final first = (widget.customerName ?? '').trim().split(' ').first;
    final test = (_payment?['environment'] ?? config.qrPay.environment) == 'sandbox';

    final qr = Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(24)),
      child: AspectRatio(
        aspectRatio: 1,
        child: switch (_status) {
          'paid' => const Center(child: ApprovedBurst()),
          _ when _url != null => QrImageView(
              key: const ValueKey('qr-code'),
              data: _url!,
              backgroundColor: Colors.white,
              eyeStyle: const QrEyeStyle(eyeShape: QrEyeShape.square, color: Colors.black),
              dataModuleStyle: const QrDataModuleStyle(dataModuleShape: QrDataModuleShape.square, color: Colors.black),
            ),
          _ when _problem != null => Center(child: Icon(Icons.qr_code_2_rounded, size: 120, color: Colors.black.withValues(alpha: 0.15))),
          _ => const Center(child: CircularProgressIndicator(color: Colors.black)),
        },
      ),
    );

    final (statusText, statusColour) = switch (_status) {
      'paid' => ('Paid, thank you', Tp.lime),
      'waiting' => ('Waiting for the payment…', context.goMuted),
      'cancelled' => ('Cancelled. Nothing was taken.', Tp.danger),
      'expired' => ('The link ran out. Nothing was taken.', Tp.danger),
      'failed' => ('The payment did not go through. Nothing was taken.', Tp.danger),
      _ when _problem != null => ('No code was made. Nothing was taken.', Tp.danger),
      _ => ('Making the code…', context.goMuted),
    };

    final info = Column(
      crossAxisAlignment: wide ? CrossAxisAlignment.start : CrossAxisAlignment.center,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (venue.isNotEmpty) Text(venue.toUpperCase(), style: t.labelLarge?.copyWith(letterSpacing: 1.4, color: context.goMuted)),
        const SizedBox(height: 6),
        Text(first.isNotEmpty ? '$first, scan to pay your bill' : 'Scan to pay your bill',
            textAlign: wide ? TextAlign.start : TextAlign.center,
            style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w800, color: Colors.white)),
        const SizedBox(height: 6),
        Text(money(widget.amountMinor),
            style: TextStyle(fontSize: wide ? 64 : 52, fontWeight: FontWeight.w900, color: Tp.lime, fontFeatures: Tp.tabular)),
        const SizedBox(height: 10),
        const _PayMarks(),
        if (test) ...[
          const SizedBox(height: 10),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(color: const Color(0xFFFFF3CD), borderRadius: BorderRadius.circular(99)),
            child: const Text('TEST PAYMENT · no real money', style: TextStyle(color: Color(0xFF7A5B00), fontWeight: FontWeight.w700, fontSize: 12)),
          ),
        ],
        const SizedBox(height: 18),
        Row(mainAxisSize: MainAxisSize.min, children: [
          if (_status == 'waiting' || (_status == 'starting' && _problem == null)) ...[
            const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
            const SizedBox(width: 10),
          ],
          Flexible(child: Text(statusText, key: const ValueKey('qr-status'), style: t.titleMedium?.copyWith(color: statusColour, fontWeight: FontWeight.w700))),
        ]),
        if (_problem != null) ...[
          const SizedBox(height: 10),
          Text(_problem!, style: t.bodyMedium?.copyWith(color: Tp.danger)),
          const SizedBox(height: 8),
          OutlinedButton(onPressed: _start, child: const Text('Try again')),
        ],
        const SizedBox(height: 22),
        Wrap(spacing: 10, runSpacing: 10, alignment: wide ? WrapAlignment.start : WrapAlignment.center, children: [
          Builder(
            builder: (anchor) => FilledButton.tonalIcon(
              key: const ValueKey('qr-share'),
              onPressed: _url == null || _status != 'waiting' ? null : () => _share(anchor),
              icon: const Icon(Icons.ios_share_rounded),
              label: const Text('Share link'),
            ),
          ),
          if (config.qrPay.emailLink)
            FilledButton.tonalIcon(
              key: const ValueKey('qr-email'),
              onPressed: _url == null || _status != 'waiting' ? null : _email,
              icon: const Icon(Icons.alternate_email_rounded),
              label: const Text('Email link'),
            ),
          OutlinedButton.icon(
            key: const ValueKey('qr-cancel'),
            onPressed: _status == 'paid' ? null : _cancel,
            icon: const Icon(Icons.close_rounded),
            label: Text(_status == 'waiting' ? 'Cancel' : 'Back'),
          ),
        ]),
      ],
    );

    return PopScope(
      canPop: _status != 'waiting',
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _cancel();
      },
      child: Scaffold(
        backgroundColor: context.goDeep,
        body: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: ConstrainedBox(
                constraints: BoxConstraints(maxWidth: wide ? 980 : 460),
                child: wide
                    ? Row(children: [
                        SizedBox(width: 400, child: qr),
                        const SizedBox(width: 40),
                        Expanded(child: info),
                      ])
                    : Column(mainAxisSize: MainAxisSize.min, children: [
                        ConstrainedBox(constraints: const BoxConstraints(maxWidth: 320), child: qr),
                        const SizedBox(height: 24),
                        info,
                      ]),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// How the customer can pay: the card schemes' and the wallets' own marks
/// (owner, 2026-11-02: "use real icons" for Apple Pay and Google Pay), each
/// on a white card as they are shown at a checkout.
class _PayMarks extends StatelessWidget {
  const _PayMarks();

  @override
  Widget build(BuildContext context) {
    Widget chip(Widget child, {double width = 58}) => Container(
          width: width,
          height: 36,
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(7), border: Border.all(color: const Color(0x22000000))),
          child: child,
        );
    Widget mark(String name, {String? label}) => SvgPicture.asset('assets/marks/$name.svg', fit: BoxFit.contain, semanticsLabel: label);
    return Wrap(spacing: 6, runSpacing: 6, children: [
      chip(mark('visa', label: 'Visa')),
      chip(Center(
        child: SizedBox(
          width: 30,
          height: 19,
          child: Stack(children: [
            Positioned(left: 0, child: Container(width: 19, height: 19, decoration: const BoxDecoration(color: Color(0xFFEB001B), shape: BoxShape.circle))),
            Positioned(left: 11, child: Container(width: 19, height: 19, decoration: BoxDecoration(color: const Color(0xFFF79E1B).withValues(alpha: 0.9), shape: BoxShape.circle))),
          ]),
        ),
      )),
      chip(mark('americanexpress', label: 'American Express'), width: 44),
      chip(mark('applepay', label: 'Apple Pay')),
      chip(mark('googlepay', label: 'Google Pay'), width: 64),
    ]);
  }
}
