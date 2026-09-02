/// A customer's cards, on the till and on the screen facing them.
///
/// THE MOVE THIS EXISTS FOR
///
/// A customer at the counter says they have a loyalty card and cannot find it,
/// or has never had one. The clerk opens this, and there is a code. The
/// customer points a phone at it and the card is in their wallet — whichever
/// phone it is, because the link decides at the far end.
///
/// SHOW IT ON THEIR SCREEN, NOT THIS ONE
///
/// The better version of that move: the till is facing the clerk and the
/// customer display is facing the customer. Asking somebody to lean over the
/// counter and scan the *operator's* screen is awkward, slow, and shows them a
/// screen with the venue's takings on it.
///
/// So "Show on the customer screen" puts the code on the display instead, using
/// the settings channel the till already owns — see
/// `data/customer_display_control.dart`. It goes back to whatever the venue had
/// there when the sheet closes, so a code put up for one customer cannot be
/// left showing to the next.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/customer_display_control.dart';
import '../data/wallet_passes.dart';
import '../main.dart';
import 'theme.dart';
import 'widgets/pos_message.dart';
import 'widgets/wallet_qr.dart';

/// Show [name]'s cards. [subjectId] is the customer, staff or promotion id.
Future<void> showWalletPasses(
  BuildContext context,
  WidgetRef ref, {
  required String subjectId,
  required String name,
}) => showModalBottomSheet<void>(
  context: context,
  isScrollControlled: true,
  showDragHandle: true,
  builder: (_) => _WalletSheet(subjectId: subjectId, name: name),
);

class _WalletSheet extends ConsumerStatefulWidget {
  const _WalletSheet({required this.subjectId, required this.name});

  final String subjectId;
  final String name;

  @override
  ConsumerState<_WalletSheet> createState() => _WalletSheetState();
}

class _WalletSheetState extends ConsumerState<_WalletSheet> {
  WalletOffer? _offer;
  String? _error;
  bool _loading = true;

  /// Which pass is currently on the customer's screen, if any.
  String? _onDisplay;

  /// What the display was showing before this sheet touched it, so it can be
  /// put back exactly. Read once, on the first push — not at open, because a
  /// sheet opened and closed without pushing anything should not write to the
  /// display at all.
  DisplayControl? _displayBefore;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    // Put the venue's own code back. Deliberately not awaited and deliberately
    // not conditional on success: a customer's card code left on a screen
    // facing the room is the one outcome worth spending a write to avoid.
    final before = _displayBefore;
    if (before != null) unawaited(writeDisplayControl(before));
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final offer = await ref
          .read(walletRepositoryProvider)
          .forSubject(widget.subjectId);
      if (!mounted) return;
      setState(() {
        _offer = offer;
        _loading = false;
      });

      // Straight onto the screen facing the customer, when the venue has asked
      // for that -- which is the default, and is the whole point of having a
      // second screen. The clerk's move becomes "open the sheet"; without this
      // it was "open the sheet, then find and press a second button", with the
      // customer waiting through both.
      //
      // Only where there is exactly one card to show. With two or more there is
      // a choice to be made and making it for them would put the wrong card in
      // front of the customer half the time.
      final settings = ref.read(cardRepositoryProvider).settings;
      if (settings.walletOnDisplay && offer.passes.length == 1) {
        await _showOnDisplay(offer.passes.first);
      }
    } on WalletException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
    }
  }

  Future<void> _showOnDisplay(WalletPass pass) async {
    _displayBefore ??= await readDisplayControl();
    final base = _displayBefore;
    if (base == null || !mounted) return;

    final written = await writeDisplayControl(
      base.copyWith(
        customerQr: pass.scanUrl,
        customerQrCaption: 'Scan to add your ${pass.label.toLowerCase()}',
      ),
    );
    if (!mounted) return;

    if (!written) {
      PosMessenger.error(context, 'The customer screen could not be updated.');
      return;
    }
    setState(() => _onDisplay = pass.kind);
    PosMessenger.success(context, 'On the customer screen.');
  }

  Future<void> _clearDisplay() async {
    final before = _displayBefore;
    if (before == null) return;
    await writeDisplayControl(before);
    if (mounted) setState(() => _onDisplay = null);
  }

  @override
  Widget build(BuildContext context) {
    final offer = _offer;

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              widget.name.trim().isEmpty ? 'Wallet cards' : widget.name,
              style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 4),
            const Text(
              'Point a phone at a code. An iPhone gets an Apple pass and '
              'anything else gets a Google one — there is nothing to choose.',
              style: TextStyle(fontSize: 12.5, height: 1.4, color: Pos.graphite),
            ),
            const SizedBox(height: 16),

            if (_loading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 40),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_error != null)
              _Note(_error!)
            else if (offer == null || !offer.enabled)
              const _Note(
                'This venue is not issuing wallet passes yet. They are switched '
                'on in the back office, under Wallet passes.',
              )
            else if (offer.passes.isEmpty)
              const _Note(
                'There are no cards to offer this customer. Check which passes '
                'the venue issues in the back office.',
              )
            else
              Flexible(
                child: ListView.separated(
                  shrinkWrap: true,
                  itemCount: offer.passes.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 14),
                  itemBuilder: (_, i) => _PassCard(
                    pass: offer.passes[i],
                    onDisplay: _onDisplay == offer.passes[i].kind,
                    onShow: () => unawaited(_showOnDisplay(offer.passes[i])),
                    onHide: () => unawaited(_clearDisplay()),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _PassCard extends StatelessWidget {
  const _PassCard({
    required this.pass,
    required this.onDisplay,
    required this.onShow,
    required this.onHide,
  });

  final WalletPass pass;
  final bool onDisplay;
  final VoidCallback onShow;
  final VoidCallback onHide;

  @override
  Widget build(BuildContext context) => Card(
    margin: EdgeInsets.zero,
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          WalletQr(data: pass.scanUrl, size: 148),
          const SizedBox(width: 18),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  pass.label,
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                if (pass.cardNumber.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(
                    pass.cardNumber,
                    style: const TextStyle(
                      fontSize: 13,
                      fontFamily: 'Consolas',
                      color: Pos.graphite,
                    ),
                  ),
                ],
                const SizedBox(height: 14),
                // The move this sheet exists for. The till faces the clerk;
                // this puts the code on the glass facing the customer.
                if (onDisplay)
                  FilledButton.tonalIcon(
                    icon: const Icon(Icons.stop_circle_outlined, size: 18),
                    label: const Text('Take it off their screen'),
                    onPressed: onHide,
                  )
                else
                  FilledButton.icon(
                    icon: const Icon(Icons.tv_outlined, size: 18),
                    label: const Text('Show on the customer screen'),
                    onPressed: onShow,
                  ),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}

class _Note extends StatelessWidget {
  const _Note(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 24),
    child: Text(
      text,
      style: const TextStyle(fontSize: 13.5, height: 1.45, color: Pos.graphite),
    ),
  );
}
