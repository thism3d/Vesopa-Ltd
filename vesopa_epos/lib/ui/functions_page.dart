import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/staff_session.dart';
import '../main.dart';
import 'card_machine_page.dart';
import 'layout.dart';
import 'theme.dart';
import 'till_actions.dart';
import 'widgets/pos_message.dart';

/// Till functions — the actions a clerk reaches for that are not part of ringing
/// up a sale: park the current bill, reprint, open the drawer for a no-sale, and
/// jump to the end-of-day reports.
///
/// Each function is wired to a real backend where one exists; where a function
/// needs hardware that may not be present (the cash drawer needs a printer set
/// up), it says so plainly rather than pretending to work.
class FunctionsPage extends ConsumerWidget {
  const FunctionsPage({
    super.key,
    required this.orderId,
    required this.onGoToReports,
    required this.onGoToReceipts,
    required this.onGoToTables,
  });

  /// The bill currently on the sale screen, so "Save to table" can park it.
  final String orderId;
  final VoidCallback onGoToReports;
  final VoidCallback onGoToReceipts;
  final VoidCallback onGoToTables;

  /// A till key is a fixed size, like a key on a keyboard.
  ///
  /// This page used to be a three-column grid, so every tile grew with the
  /// window — on a desktop till that made eight ~600px slabs of flat colour,
  /// which is neither quicker to hit nor easier to read. Fixed tiles keep the
  /// same muscle memory at every window size; the *number of columns* changes
  /// instead, which is what a Wrap does for free.
  static const _tileWidth = 236.0;
  static const _tileHeight = 132.0;

  /// Past this the groups stop reading as columns and start reading as a wall.
  static const _contentMaxWidth = 1120.0;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final phone = context.isPhone;

    // Grouped by what the clerk is trying to do. Eight unrelated keys in one
    // flat grid means reading all eight labels every time; four short groups
    // means reading one heading.
    final groups = <_Group>[
      _Group('This sale', [
        _Function(
          'Save to Table',
          Icons.table_restaurant,
          Pos.teal,
          'Park this bill so you can start another.',
          () => _saveToTable(context, ref),
        ),
        _Function(
          'Tables',
          Icons.grid_view,
          Pos.purple,
          'Recall a parked bill, transfer or split it.',
          onGoToTables,
        ),
      ]),
      _Group('Receipts', [
        _Function(
          'Reprint Last',
          Icons.receipt_long,
          Pos.indigo,
          'Another copy of the most recent sale.',
          () => TillActions.reprintLastReceipt(context, ref),
        ),
        _Function(
          'Receipt History',
          Icons.history,
          Pos.cyan,
          'Browse and reprint any earlier sale.',
          onGoToReceipts,
        ),
      ]),
      _Group('Cash & card', [
        _Function(
          'No Sale',
          Icons.point_of_sale,
          Pos.amber,
          'Open the drawer without ringing up a sale.',
          () => TillActions.openCashDrawer(context, ref),
        ),
        // The card machine's own end of day can only be started from the till
        // on an integrated reader, so it needs a key of its own or the venue
        // cannot cash the machine up.
        _Function(
          'Card Machine',
          Icons.contactless,
          Pos.brandDeep,
          'End of day, balances and refunds on the PDQ.',
          () => Navigator.of(context).push(
            MaterialPageRoute<void>(builder: (_) => const CardMachinePage()),
          ),
        ),
      ]),
      _Group('End of day', [
        _Function(
          'X Report',
          Icons.refresh,
          Pos.blue,
          "Read the period's takings without closing it.",
          onGoToReports,
        ),
        _Function(
          'Z Report',
          Icons.lock_clock,
          Pos.red,
          'Close the trading period and reset the totals.',
          onGoToReports,
        ),
      ]),
    ];

    // Starting and ending a shift belong on this page as well as the rail:
    // mid-service actions are what staff come here for, and handing the till to a
    // colleague is one of them. Shown only where the venue uses sign-on and this
    // terminal can actually check a PIN.
    final staffSession = ref.watch(staffSessionProvider);
    final usesSignOn = ref.watch(tillSettingsProvider).idleRequirePin &&
        ref.watch(canSignOnProvider);

    if (usesSignOn) {
      groups.add(
        _Group('Shift', [
          if (staffSession.signedOn)
            _Function(
              'Sign Off',
              Icons.how_to_reg_outlined,
              Pos.graphite,
              'Lock the till and hand it to the next member of staff. '
                  'The bill on screen is left exactly as it is.',
              () => ref.read(staffSessionProvider.notifier).signOff(),
            )
          else
            _Function(
              'Sign On',
              Icons.login,
              Pos.brandDeep,
              'Enter your PIN to start a shift. Everything you ring up is '
                  'recorded against your name.',
              () => ref.read(staffSessionProvider.notifier).promptSignOn(),
            ),
        ]),
      );
    }

    return SingleChildScrollView(
      padding: EdgeInsets.all(phone ? 12 : 20),
      child: Align(
        alignment: Alignment.topLeft,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: _contentMaxWidth),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(left: 4, bottom: 4),
                child: Text(
                  'Functions',
                  style: TextStyle(
                    fontSize: phone ? 22 : 26,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.only(left: 4, bottom: 18),
                child: Text(
                  'Everything that is not ringing up a sale.',
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
              // The groups themselves wrap too. Stacked one per row they left
              // the right half of a desktop till empty and pushed End of day
              // below the fold; two to a row fills the width and keeps every
              // key on one screen.
              Wrap(
                spacing: 30,
                runSpacing: 22,
                children: [
                  for (final group in groups)
                    SizedBox(
                      width: phone
                          ? MediaQuery.sizeOf(context).width - 24
                          : _tileWidth * 2 + 12,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          _GroupHeading(group.title),
                          Row(
                            children: [
                              for (final f in group.functions) ...[
                                Expanded(
                                  child: SizedBox(
                                    height: _tileHeight,
                                    child: _FunctionTile(f),
                                  ),
                                ),
                                if (f != group.functions.last)
                                  const SizedBox(width: 12),
                              ],
                            ],
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// "Save Memory" — park the current bill against a table number so the clerk
  /// can begin a fresh sale and come back to this one from Tables.
  Future<void> _saveToTable(BuildContext context, WidgetRef ref) async {
    final lines = await ref.read(orderRepositoryProvider).watchLines(orderId).first;
    if (!context.mounted) return;
    if (lines.isEmpty) {
      _toast(context, 'Nothing to save — this bill is empty.');
      return;
    }

    final number = await _askTableNumber(context);
    if (number == null || !context.mounted) return;

    await ref.read(tableRepositoryProvider).park(orderId, number);
    if (!context.mounted) return;
    _toast(context, 'Saved to table $number.');
    onGoToTables();
  }

  Future<int?> _askTableNumber(BuildContext context) async {
    final controller = TextEditingController();
    return showDialog<int>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Save to which table?'),
        content: TextField(
          controller: controller,
          autofocus: true,
          keyboardType: TextInputType.number,
          decoration: const InputDecoration(labelText: 'Table number'),
          onSubmitted: (v) => Navigator.pop(context, int.tryParse(v)),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () =>
                Navigator.pop(context, int.tryParse(controller.text)),
            child: const Text('Save'),
          ),
        ],
      ),
    );
  }

  void _toast(BuildContext context, String message) {
    PosMessenger.info(context, message);
  }
}

class _Function {
  const _Function(
    this.label,
    this.icon,
    this.color,
    this.hint,
    this.onTap,
  );
  final String label;
  final IconData icon;
  final Color color;
  final String hint;
  final VoidCallback onTap;
}

/// A set of related keys, under one heading.
class _Group {
  const _Group(this.title, this.functions);
  final String title;
  final List<_Function> functions;
}

class _GroupHeading extends StatelessWidget {
  const _GroupHeading(this.title);
  final String title;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(left: 4, bottom: 8),
      child: Row(
        children: [
          Text(
            title.toUpperCase(),
            style: TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.1,
              color: scheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(width: 10),
          Expanded(child: Divider(height: 1, color: scheme.outlineVariant)),
        ],
      ),
    );
  }
}

class _FunctionTile extends StatelessWidget {
  const _FunctionTile(this.function);
  final _Function function;

  @override
  Widget build(BuildContext context) {
    // These colours span amber to indigo, so the label works out its own
    // contrast. White on Pos.amber was under 2:1 — unreadable on a bright
    // counter, and the new palette only made that worse.
    final ink = Pos.inkOn(function.color);

    return Material(
      color: function.color,
      borderRadius: BorderRadius.circular(12),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: function.onTap,
        child: Padding(
          padding: const EdgeInsets.all(13),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 34,
                height: 34,
                decoration: BoxDecoration(
                  color: ink.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(9),
                ),
                child: Icon(function.icon, color: ink, size: 20),
              ),
              const Spacer(),
              Text(
                function.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: ink,
                  fontSize: 15,
                  fontWeight: FontWeight.w800,
                ),
              ),
              const SizedBox(height: 3),
              Text(
                function.hint,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: ink.withValues(alpha: 0.78),
                  fontSize: 11.5,
                  height: 1.25,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
