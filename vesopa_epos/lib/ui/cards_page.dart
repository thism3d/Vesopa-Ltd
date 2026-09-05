/// Making cards, and proving the reader works.
///
/// Three things live here, and they are the three questions a venue actually
/// has about swipe cards:
///
///   * **What does this till think a card is?** The prefixes, shown but not
///     editable — they belong to the venue, are set once in the back office,
///     and are pushed to every terminal. A till that could change them locally
///     would be a venue where the same card does different things at different
///     ends of the bar.
///   * **Is the reader working?** Swipe anything and see exactly what arrived,
///     including cards this venue does not use. When somebody rings up to say
///     cards have stopped working, this is the screen that answers it.
///   * **Give somebody a card.** Take the next number, attach it to a member or
///     a member of staff, and print the track to encode.
///
/// WHAT "WRITING A CARD" MEANS HERE
///
/// Not encoding a stripe. There is no writer attached to a till and there
/// should not be — a venue encodes plastic on whatever machine it already owns,
/// at the back, later, and usually not at the moment the member is standing
/// there. What has to be right at this end is the *number*: allocated once,
/// never reissued, attached to exactly one person, and handed over in a form
/// nobody has to read down a phone.
///
/// So this issues the number and prints the track. The plastic is made
/// elsewhere, from the slip.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/card_repository.dart';
import '../data/local/database.dart';
import '../data/staff_session.dart';
import '../data/swipe_cards.dart';
import '../data/terminal_identity.dart';
import '../main.dart';
import '../printing/print_service.dart';
import '../printing/receipt_builder.dart';
import 'customer_picker.dart';
import 'wallet_passes_sheet.dart';
import 'printers_page.dart' show printerSettingsProvider;
import 'theme.dart';
import 'widgets/pos_message.dart';

/// The most recent card read on this till, for the reader test below.
///
/// A provider rather than page state, because the swipe that proves the reader
/// works arrives through the listener wrapped around the whole shell — see
/// `ui/swipe_listener.dart` — and not through this page. The page is a window
/// onto it.
///
/// Deliberately not persisted anywhere. It is a diagnostic, live only while the
/// till is running, and a card number written to disk for the benefit of a
/// support screen would be a card number written to disk.
class LastCardRead extends Notifier<SwipedCard?> {
  @override
  SwipedCard? build() => null;

  void saw(SwipedCard card) => state = card;
}

final lastCardReadProvider = NotifierProvider<LastCardRead, SwipedCard?>(
  LastCardRead.new,
);

class CardsPage extends ConsumerStatefulWidget {
  const CardsPage({super.key});

  @override
  ConsumerState<CardsPage> createState() => _CardsPageState();
}

class _CardsPageState extends ConsumerState<CardsPage> {
  bool _busy = false;

  @override
  Widget build(BuildContext context) {
    final cards = ref.watch(cardRepositoryProvider);
    // The repository is one long-lived object whose settings change in place, so
    // watching it alone would never rebuild this page. The revision is what
    // moves when the back office changes the rules.
    ref.watch(cardRulesRevisionProvider);
    final settings = cards.settings;
    final last = ref.watch(lastCardReadProvider);

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const _SectionTitle('What this till reads'),
        Card(
          margin: EdgeInsets.zero,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (!settings.enabled)
                  const Text(
                    'Card reading is switched off for this venue. Nothing '
                    'swiped or scanned at this till will be acted on.',
                    style: TextStyle(fontSize: 13, height: 1.4),
                  )
                else
                  const Text(
                    'A card is recognised by the digits it starts with. These '
                    'are set once for the venue, in the back office under '
                    'Cards, and every till follows them — so the same card does '
                    'the same thing wherever it is swiped.',
                    style: TextStyle(fontSize: 13, height: 1.4),
                  ),
                const SizedBox(height: 14),
                for (final kind in CardKind.values)
                  _PrefixRow(kind: kind, prefix: settings.prefixFor(kind)),
              ],
            ),
          ),
        ),

        const SizedBox(height: 28),
        const _SectionTitle('Is the reader working?'),
        Card(
          margin: EdgeInsets.zero,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  'Swipe or scan anything at all — a staff card, a loyalty '
                  'card, a hotel key, a customer\'s phone. Whatever the reader '
                  'sends appears here, whether this venue uses that card or '
                  'not.',
                  style: TextStyle(fontSize: 13, height: 1.4),
                ),
                const SizedBox(height: 14),
                if (last == null)
                  const _Waiting()
                else
                  _LastRead(card: last, settings: settings),
              ],
            ),
          ),
        ),

        // Both of the next two sections are the venue's to switch off. A venue
        // with no card printer has no use for the second, and a venue that has
        // never set Wallet up has no use for the first -- and a button that
        // produces an error every time it is pressed teaches the counter to
        // distrust the screen it is on.
        if (settings.tillWalletButton) ...[
        const SizedBox(height: 28),
        const _SectionTitle('Cards on a phone'),
        Card(
          margin: EdgeInsets.zero,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  'The same card, on a phone. The barcode carries the same '
                  'number as the plastic, so a phone and a card scan to the '
                  'same person at this till.',
                  style: TextStyle(fontSize: 13, height: 1.4),
                ),
                const SizedBox(height: 6),
                const Text(
                  'Pick a customer and the code can be put on the screen '
                  'facing them, so nobody has to lean over the counter.',
                  style: TextStyle(fontSize: 12.5, height: 1.4),
                ),
                const SizedBox(height: 16),
                Align(
                  alignment: Alignment.centerLeft,
                  child: FilledButton.tonalIcon(
                    icon: const Icon(Icons.account_balance_wallet_outlined),
                    label: const Text('Show a customer their cards'),
                    onPressed: _showWalletCards,
                  ),
                ),
              ],
            ),
          ),
        ),

        ],

        if (settings.tillPrintButton) ...[
        const SizedBox(height: 28),
        const _SectionTitle('Give somebody a card'),
        Card(
          margin: EdgeInsets.zero,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  'This takes the next number for the programme and attaches it '
                  'to whoever you choose. It does not encode the plastic — no '
                  'till has a card writer on it — so it prints the exact track '
                  'to encode, for whatever writer the venue uses.',
                  style: TextStyle(fontSize: 13, height: 1.4),
                ),
                const SizedBox(height: 6),
                const Text(
                  'A number is never handed out twice, even after a card is '
                  'cancelled: the lost one is still out there.',
                  style: TextStyle(fontSize: 12.5, height: 1.4),
                ),
                const SizedBox(height: 16),
                if (!cards.canIssue)
                  const Text(
                    'This terminal was set up before card issuing existed. '
                    'Sign the till in again from Settings to enable it.',
                    style: TextStyle(fontSize: 13, height: 1.4),
                  )
                else
                  Wrap(
                    spacing: 10,
                    runSpacing: 10,
                    children: [
                      for (final kind in CardKind.values)
                        if (settings.prefixFor(kind).isNotEmpty)
                          FilledButton.icon(
                            icon: Icon(_iconFor(kind)),
                            label: Text('New ${_labelFor(kind).toLowerCase()} card'),
                            onPressed: _busy ? null : () => _issue(kind),
                          ),
                    ],
                  ),
              ],
            ),
          ),
        ),
        ],

        // Neither switch on is a deliberate configuration, not an empty screen.
        // The reader test above is still the reason to be here, so this says so
        // rather than leaving the page looking half-loaded.
        if (!settings.tillWalletButton && !settings.tillPrintButton) ...[
          const SizedBox(height: 28),
          const Text(
            'Handing out cards is switched off for this venue. The reader test '
            'above still works. Turn the buttons back on in the back office, '
            'under Cards.',
            style: TextStyle(fontSize: 13, height: 1.4, color: Pos.graphite),
          ),
        ],
      ],
    );
  }

  /// Pick a customer, then show what they can put on their phone.
  ///
  /// The picker first and the sheet second, deliberately: the codes are built
  /// per person, so there is nothing to show until there is somebody to show it
  /// to.
  Future<void> _showWalletCards() async {
    final customer = await pickCustomer(context, ref);
    if (customer == null || !mounted) return;

    await showWalletPasses(
      context,
      ref,
      subjectId: customer.id,
      name: customer.name,
    );
  }

  // ---------------------------------------------------------------------------
  // Issuing
  // ---------------------------------------------------------------------------

  Future<void> _issue(CardKind kind) async {
    // Who it is for, before a number is taken. Deliberately this way round: a
    // number claimed and then abandoned because the clerk backed out of the
    // picker is a gap in the venue's numbering that nobody can explain later.
    String? subjectId;
    String? subjectName;

    switch (kind) {
      case CardKind.loyalty:
      case CardKind.membership:
        final customer = await pickCustomer(context, ref);
        if (customer == null) return;
        subjectId = customer.id;
        subjectName = customer.name;

      case CardKind.clerk:
        final staff = await _pickStaff();
        if (staff == null) return;
        subjectId = staff.id.toString();
        subjectName = staff.name;

      case CardKind.gift:
        // A gift card belongs to nobody until it is bought. Issuing one creates
        // the card with a zero balance; the money goes on it at the till when
        // somebody pays for it.
        subjectName = await _askRecipient();
        if (subjectName == null) return;
    }

    if (!mounted) return;
    setState(() => _busy = true);

    try {
      final issued = await ref
          .read(cardRepositoryProvider)
          .issue(
            kind: kind,
            subjectId: subjectId,
            subjectName: subjectName,
            issuedBy: ref.read(staffSessionProvider).name,
            terminal: ref.read(terminalNameProvider),
          );
      if (!mounted) return;
      setState(() => _busy = false);
      await _showIssued(issued, holder: subjectName);
    } on CardException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      PosMessenger.error(context, e.message);
    }
  }

  /// The number, big, with the track under it.
  ///
  /// Both are on screen because they are used by two different people: the
  /// number is what goes in the back office and on a wallet pass, and the track
  /// — sentinels included — is what goes into an encoder. Showing only one of
  /// them is how a `;` ends up encoded as part of the number, or left off it.
  Future<void> _showIssued(IssuedCard issued, {String? holder}) => showDialog(
    context: context,
    builder: (context) => AlertDialog(
      title: Text('${_labelFor(issued.kind)} card issued'),
      content: SizedBox(
        width: 380,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (holder != null && holder.trim().isNotEmpty) ...[
              Text(
                holder,
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 12),
            ],
            _BigNumber(label: 'CARD NUMBER', value: issued.cardNumber),
            const SizedBox(height: 12),
            _BigNumber(label: 'ENCODE ON TRACK 2', value: issued.track),
            const SizedBox(height: 10),
            const Text(
              'The track includes the ; and the ? — a card encoded without them '
              'will not read.',
              style: TextStyle(fontSize: 12.5, height: 1.4),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Done'),
        ),
        FilledButton.icon(
          icon: const Icon(Icons.print_outlined, size: 18),
          label: const Text('Print it'),
          onPressed: () {
            Navigator.of(context).pop();
            unawaited(_print(issued, holder: holder));
          },
        ),
      ],
    ),
  );

  Future<void> _print(IssuedCard issued, {String? holder}) async {
    try {
      final printers = await ref.read(printerSettingsProvider.future);
      final branding = ref.read(brandingProvider);

      final service = PrintService(
        await ReceiptBuilder.create(paperWidthMm: printers.receiptWidthMm),
        PrinterSetup(
          printers: printers,
          shopName: branding.venueName.isNotEmpty
              ? branding.venueName
              : ref.read(sessionProvider).venueName,
          footer: branding.footerMessage,
          logo: branding.showLogo ? branding.logoBytes : null,
        ),
      );

      await service.printCardSlip(
        kindLabel: _labelFor(issued.kind).toUpperCase(),
        cardNumber: issued.cardNumber,
        track: issued.track,
        holder: holder,
        issuedBy: ref.read(staffSessionProvider).name,
      );
      if (mounted) PosMessenger.success(context, 'Card slip printed.');
    } on Object catch (e) {
      if (!mounted) return;
      // The number is already issued and attached. A printer that would not
      // take the slip has cost a piece of paper, not the card — and saying so
      // matters, because "print failed" reads like "the card failed".
      PosMessenger.error(
        context,
        'The card was issued. Only the slip did not print — $e',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Choosing who
  // ---------------------------------------------------------------------------

  Future<StaffData?> _pickStaff() async {
    final staff = await ref.read(staffRepositoryProvider).all();
    if (!mounted || staff.isEmpty) {
      if (mounted) {
        PosMessenger.error(context, 'This venue has no staff list on this till.');
      }
      return null;
    }

    return showDialog<StaffData>(
      context: context,
      builder: (context) => SimpleDialog(
        title: const Text('Whose card is it?'),
        children: [
          for (final person in staff)
            ListTile(
              title: Text(person.name),
              subtitle: person.swipeCard.isEmpty
                  ? null
                  // Said plainly, because issuing a second card to somebody who
                  // already has one replaces theirs — the old card stops
                  // working the moment this one is attached, and finding that
                  // out at a counter is a bad way to learn it.
                  : Text(
                      'Already has card ${person.swipeCard} — a new one '
                      'replaces it',
                      style: const TextStyle(fontSize: 12),
                    ),
              onTap: () => Navigator.of(context).pop(person),
            ),
        ],
      ),
    );
  }

  Future<String?> _askRecipient() {
    final name = TextEditingController();
    return showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('New gift card'),
        content: SizedBox(
          width: 320,
          child: TextField(
            controller: name,
            autofocus: true,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(
              labelText: 'Who is it for (optional)',
              helperText: 'The card is created empty. Money goes on it when '
                  'somebody pays for it.',
              helperMaxLines: 3,
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            // Empty is a real answer — a rack of blank gift cards behind the
            // bar has no recipient until one is bought — so this returns a
            // string rather than refusing.
            onPressed: () => Navigator.of(context).pop(name.text.trim()),
            child: const Text('Create'),
          ),
        ],
      ),
    );
  }
}

// -----------------------------------------------------------------------------

String _labelFor(CardKind kind) => switch (kind) {
  CardKind.clerk => 'Staff',
  CardKind.loyalty => 'Loyalty',
  CardKind.gift => 'Gift',
  CardKind.membership => 'Membership',
};

IconData _iconFor(CardKind kind) => switch (kind) {
  CardKind.clerk => Icons.badge_outlined,
  CardKind.loyalty => Icons.card_giftcard_outlined,
  CardKind.gift => Icons.redeem_outlined,
  CardKind.membership => Icons.card_membership_outlined,
};

class _PrefixRow extends StatelessWidget {
  const _PrefixRow({required this.kind, required this.prefix});

  final CardKind kind;
  final String prefix;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 5),
    child: Row(
      children: [
        Icon(_iconFor(kind), size: 18, color: Pos.graphite),
        const SizedBox(width: 10),
        Expanded(child: Text(_labelFor(kind))),
        Text(
          prefix.isEmpty ? 'not used' : prefix,
          style: TextStyle(
            fontFamily: prefix.isEmpty ? null : 'Consolas',
            fontSize: prefix.isEmpty ? 13 : 16,
            fontWeight: prefix.isEmpty ? FontWeight.normal : FontWeight.w700,
            color: prefix.isEmpty ? Pos.graphite : null,
          ),
        ),
      ],
    ),
  );
}

class _Waiting extends StatelessWidget {
  const _Waiting();

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(vertical: 20),
    alignment: Alignment.center,
    child: Text(
      'Nothing read yet on this till.',
      style: TextStyle(color: Pos.graphite),
    ),
  );
}

/// What the reader last sent, and what the till made of it.
///
/// Both halves matter. A venue whose cards have "stopped working" is nearly
/// always one where the reader is fine and the prefix does not match — and
/// showing only "unknown card" leaves nobody able to tell that from a dead
/// reader.
class _LastRead extends StatelessWidget {
  const _LastRead({required this.card, required this.settings});

  final SwipedCard card;
  final CardSettings settings;

  @override
  Widget build(BuildContext context) {
    final kind = settings.classify(card.number);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _BigNumber(label: 'NUMBER READ', value: card.number),
        const SizedBox(height: 10),
        _Fact(
          'Read by',
          card.via == ReadVia.swipe
              ? 'the stripe reader'
              : 'a scanner or tag reader',
        ),
        _Fact('Exactly as sent', card.raw),
        _Fact(
          'This venue calls it',
          kind == null
              ? 'nothing — no programme uses that prefix'
              : '${_labelFor(kind).toLowerCase()} '
                    '(prefix ${settings.prefixFor(kind)})',
        ),
      ],
    );
  }
}

class _Fact extends StatelessWidget {
  const _Fact(this.label, this.value);

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 3),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 150,
          child: Text(
            label,
            style: TextStyle(
              fontSize: 12.5,
              color: Pos.graphite,
            ),
          ),
        ),
        Expanded(
          child: SelectableText(
            value,
            style: const TextStyle(fontSize: 12.5, fontFamily: 'Consolas'),
          ),
        ),
      ],
    ),
  );
}

/// A number meant to be read across a counter or typed into an encoder.
///
/// Selectable, because the one thing somebody will want to do with it is copy
/// it into whatever software drives their card writer.
class _BigNumber extends StatelessWidget {
  const _BigNumber({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
    decoration: BoxDecoration(
      color: Theme.of(context).posChrome,
      borderRadius: BorderRadius.circular(10),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: TextStyle(
            fontSize: 10,
            letterSpacing: 1.8,
            fontWeight: FontWeight.w700,
            color: Pos.graphite,
          ),
        ),
        const SizedBox(height: 4),
        SelectableText(
          value,
          style: const TextStyle(
            fontSize: 24,
            fontFamily: 'Consolas',
            fontWeight: FontWeight.w700,
          ),
        ),
      ],
    ),
  );
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: Text(
      text,
      style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
    ),
  );
}
