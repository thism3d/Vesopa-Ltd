/// Taking an order: the menu by category, the bill underneath, Send.
///
/// What PocketTouch does, and what it does not:
///   * options the dish needs are asked before it goes on (cooking, side)
///   * allergens on every dish, and a note on any line
///   * by-seat ordering, so the bill can be split by seat later
///   * out of stock is greyed out and cannot be rung up
///   * a sent line can only come off with a void (the till's rule)
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models.dart';
import '../../data/session.dart';
import '../product_photo.dart';
import '../sounds.dart';
import '../theme.dart';
import 'note_sheet.dart';
import '../../counter/ui/product_sheet.dart';
import 'bill.dart';

class OrderPage extends ConsumerStatefulWidget {
  const OrderPage({super.key, required this.billId});
  final String billId;
  @override
  ConsumerState<OrderPage> createState() => _OrderPageState();
}

class _OrderPageState extends ConsumerState<OrderPage> {
  String? _category;
  int _seat = 0;

  /// Mains (and desserts) go on held, to be fired when the table is ready.
  bool _holdMains = false;

  Future<void> _void(Bill bill, BillLine line) async {
    final s = ref.read(tapProvider);
    final reasons = ['Wrong item', 'Changed their mind', 'Quality', 'Took too long', 'Other'];
    String reason = reasons.first;
    var qty = 1;
    final pin = TextEditingController();
    // The till's void key: the clerk voids alone if they hold it.
    final isManager = s.clerk?.can(TillPermission.voidLine) ?? false;
    final ok = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (c) => StatefulBuilder(
        builder: (c, setSheet) => Padding(
          padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.of(c).viewInsets.bottom),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('Void ${line.product.name}', style: Theme.of(c).textTheme.titleLarge),
            const SizedBox(height: 4),
            Text('It has gone to the kitchen, so it comes off with a reason and a manager\'s approval.', style: Theme.of(c).textTheme.bodySmall),
            const SizedBox(height: 12),
            if (line.unpaidQuantity > 1)
              Row(children: [
                const Text('How many'),
                const Spacer(),
                IconButton(onPressed: qty > 1 ? () => setSheet(() => qty--) : null, icon: const Icon(Icons.remove_circle_outline)),
                Text('$qty', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
                IconButton(onPressed: qty < line.unpaidQuantity ? () => setSheet(() => qty++) : null, icon: const Icon(Icons.add_circle_outline)),
              ]),
            Wrap(spacing: 6, runSpacing: 6, children: [
              for (final r in reasons) ChoiceChip(label: Text(r), selected: reason == r, onSelected: (_) => setSheet(() => reason = r)),
            ]),
            if (!isManager) ...[
              const SizedBox(height: 12),
              TextField(
                controller: pin,
                obscureText: true,
                keyboardType: TextInputType.number,
                maxLength: 6,
                decoration: const InputDecoration(labelText: 'Manager\'s PIN', counterText: ''),
              ),
            ],
            const SizedBox(height: 12),
            FilledButton(onPressed: () => Navigator.pop(c, true), child: Text('Void ${money(line.unitMinor * qty)}')),
          ]),
        ),
      ),
    );
    if (ok != true || !mounted) return;
    final notifier = ref.read(tapProvider.notifier);
    final approver = isManager ? s.clerk! : notifier.managerByPin(pin.text.trim(), TillPermission.voidLine);
    if (approver == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('That is not a manager\'s PIN. Nothing was voided.')));
      return;
    }
    notifier.voidLine(bill.id, line.id, quantity: qty, reason: reason, approvedBy: approver);
    HapticFeedback.mediumImpact();
  }

  Future<void> _add(Product p, {String note = ''}) async {
    if (p.outOfStock) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('${p.name} is out of stock')));
      return;
    }
    // The counter's sheet: every choice at once (portion, cooking, optional
    // add-ons), how many, then Add. Cancelled: nothing goes on half-chosen.
    var choices = const <Choice>[];
    var quantity = 1;
    if (p.options.isNotEmpty) {
      final picked = await pickOptions(context, p);
      if (picked == null) return;
      choices = picked.choices;
      quantity = picked.quantity;
    }
    final session = ref.read(tapProvider.notifier);
    final line = session.addLine(widget.billId, p, choices: choices, note: note, seat: _seat, hold: _holdMains && p.course >= 2);
    if (quantity > 1) session.changeQuantity(widget.billId, line, quantity - 1);
    final go = ref.read(tapProvider).config.go;
    final warn = p.allergens.isNotEmpty && go.allergenAlerts;
    GoSounds.play(go, warn ? GoSound.allergen : GoSound.add);
    if (warn && mounted) {
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(
          backgroundColor: Tp.amber,
          duration: const Duration(seconds: 3),
          content: Text('${p.name} contains ${p.allergens.join(', ')}. Check with the customer.',
              style: const TextStyle(color: Tp.onLime, fontWeight: FontWeight.w700)),
        ));
    }
  }

  /// Long-press a dish: a note (and the venue's quick notes) before it goes on.
  Future<void> _addWithNote(Product p) async {
    final note = await askNote(context, ref, title: p.name);
    if (note == null) return;
    await _add(p, note: note);
  }

  /// Tap an unsent line: its note.
  Future<void> _editNote(Bill bill, BillLine l) async {
    final note = await askNote(context, ref, title: l.product.name, initial: l.note);
    if (note != null) ref.read(tapProvider.notifier).setNote(bill.id, l.id, note);
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(tapProvider);
    final bill = s.bills[widget.billId];
    if (bill == null) {
      return Scaffold(appBar: AppBar(), body: const Center(child: Text('This bill is closed.')));
    }
    final cat = _category ?? (s.categories.isEmpty ? null : s.categories.first.id);
    final products = s.products.where((p) => p.category == cat).toList();
    final t = Theme.of(context).textTheme;
    final unsent = bill.lines.where((l) => !l.sent && !l.held).length;

    return Scaffold(
      appBar: AppBar(
        title: Text(bill.name),
        actions: [
          if (s.products.any((p) => p.course >= 2))
            Padding(
              padding: const EdgeInsets.only(right: 4),
              child: FilterChip(
                label: const Text('Hold mains'),
                selected: _holdMains,
                onSelected: (v) => setState(() => _holdMains = v),
                tooltip: 'Mains go on held, and are fired when the table is ready',
              ),
            ),
          if (bill.covers > 0)
            PopupMenuButton<int>(
              tooltip: 'Seat',
              initialValue: _seat,
              onSelected: (v) => setState(() => _seat = v),
              itemBuilder: (_) => [
                const PopupMenuItem(value: 0, child: Text('Whole table')),
                for (var i = 1; i <= bill.covers; i++) PopupMenuItem(value: i, child: Text('Seat $i')),
              ],
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: Chip(avatar: const Icon(Icons.event_seat_rounded, size: 18), label: Text(_seat == 0 ? 'Table' : 'Seat $_seat')),
              ),
            ),
        ],
      ),
      body: LayoutBuilder(builder: (context, box) {
        // An iPad on its side: the menu on the left, the ticket on the right,
        // as the till lays its sale screen out. A phone: one above the other.
        final wide = box.maxWidth >= 900;
        final menu = <Widget>[
        SizedBox(
          height: 56,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 12),
            children: [
              for (final c in s.categories)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
                  child: ChoiceChip(
                    label: Text(c.name),
                    selected: c.id == cat,
                    avatar: CircleAvatar(backgroundColor: Color(c.colour), radius: 6),
                    onSelected: (_) => setState(() => _category = c.id),
                  ),
                ),
            ],
          ),
        ),
        Expanded(
          flex: 3,
          child: GridView.builder(
            padding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
            gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 200, mainAxisSpacing: 10, crossAxisSpacing: 10, childAspectRatio: 1.6),
            itemCount: products.length,
            itemBuilder: (_, i) {
              final p = products[i];
              final colour = Color(s.categories.firstWhere((c) => c.id == p.category, orElse: () => s.categories.first).colour);
              return Opacity(
                opacity: p.outOfStock ? 0.4 : 1,
                child: Card(
                  child: InkWell(
                    borderRadius: BorderRadius.circular(Tp.radius),
                    onTap: () => _add(p),
                    onLongPress: s.config.go.noteLongPress ? () => _addWithNote(p) : null,
                    child: Container(
                      decoration: BoxDecoration(borderRadius: BorderRadius.circular(Tp.radius), border: Border(top: BorderSide(color: colour, width: 4))),
                      padding: const EdgeInsets.all(12),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        ProductPhoto(product: p, tint: colour, height: 40, radius: 8),
                        Text(p.name, style: t.titleSmall?.copyWith(fontWeight: FontWeight.w700), maxLines: 2, overflow: TextOverflow.ellipsis),
                        const Spacer(),
                        Row(children: [
                          Expanded(child: Money(p.priceMinor, style: t.bodyMedium)),
                          if (p.allergens.isNotEmpty) const Icon(Icons.warning_amber_rounded, size: 16, color: Tp.amber),
                          if (p.outOfStock) Padding(padding: const EdgeInsets.only(left: 4), child: Text('Out', style: t.bodySmall?.copyWith(color: Tp.danger))),
                        ]),
                      ]),
                    ),
                  ),
                ),
              );
            },
          ),
        ),
        ];
        final ticket = <Widget>[
        if (wide)
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 14, 18, 10),
            child: Row(children: [
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(bill.name, style: t.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
                Text([if (bill.covers > 0) '${bill.covers} covers', if (bill.clerk.trim().isNotEmpty) bill.clerk].join(' · '), style: t.bodySmall),
              ])),
              Money(bill.dueMinor, style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
            ]),
          ),
        const Divider(height: 1),
        Expanded(
          flex: 2,
          child: bill.lines.isEmpty
              ? Center(child: Text('Tap a dish to add it', style: t.bodyMedium))
              : ListView(children: [
                  for (final l in bill.lines.reversed)
                    // The till's gestures: right adds one more, left takes it
                    // off (a void with a reason once it has gone to the kitchen).
                    Dismissible(
                      key: ValueKey('tline-${l.id}'),
                      direction: l.unpaidQuantity > 0 ? DismissDirection.horizontal : DismissDirection.none,
                      confirmDismiss: (dir) async {
                        final n = ref.read(tapProvider.notifier);
                        if (dir == DismissDirection.startToEnd) {
                          if (!l.sent) n.changeQuantity(bill.id, l.id, 1);
                        } else if (l.sent) {
                          await _void(bill, l);
                        } else {
                          n.changeQuantity(bill.id, l.id, -l.quantity);
                        }
                        HapticFeedback.selectionClick();
                        return false;
                      },
                      background: Container(color: Tp.green.withValues(alpha: 0.85), alignment: Alignment.centerLeft, padding: const EdgeInsets.only(left: 20), child: const Icon(Icons.add_rounded, color: Colors.white)),
                      secondaryBackground: Container(color: Tp.danger.withValues(alpha: 0.9), alignment: Alignment.centerRight, padding: const EdgeInsets.only(right: 20), child: Icon(l.sent ? Icons.block_rounded : Icons.delete_outline_rounded, color: Colors.white)),
                      child: ListTile(
                      dense: true,
                      leading: CircleAvatar(
                        radius: 14,
                        backgroundColor: l.sent ? Tp.lime.withValues(alpha: 0.2) : Tp.amber.withValues(alpha: 0.25),
                        child: Text('${l.quantity}', style: const TextStyle(fontWeight: FontWeight.w800)),
                      ),
                      title: Text(l.product.name),
                      subtitle: Text([
                        ...l.choices.map((c) => c.name),
                        if (l.note.isNotEmpty) 'Note: ${l.note}',
                        if (l.seat > 0) 'Seat ${l.seat}',
                        if (l.product.allergens.isNotEmpty) 'Contains ${l.product.allergens.join(', ')}',
                        if (l.held && !l.sent) 'Held',
                        if (l.sent) 'Sent · hold to void',
                      ].join(' · ')),
                      onLongPress: l.sent && l.unpaidQuantity > 0 ? () => _void(bill, l) : null,
                      onTap: l.sent ? null : () => _editNote(bill, l),
                      trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                        if (!l.sent) IconButton(icon: const Icon(Icons.remove_circle_outline), onPressed: () => ref.read(tapProvider.notifier).changeQuantity(bill.id, l.id, -1)),
                        Money(l.totalMinor, style: t.bodyMedium),
                      ]),
                    ),
                    ),
                ]),
        ),
        if (bill.hasHeld)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            child: FilledButton.tonalIcon(
              style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
              icon: const Icon(Icons.local_fire_department_rounded),
              label: Text('Fire mains (${bill.lines.where((l) => l.held && !l.sent).length})'),
              onPressed: () {
                ref.read(tapProvider.notifier).fire(bill.id);
                HapticFeedback.mediumImpact();
              },
            ),
          ),
        SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
            child: Row(children: [
              Expanded(
                child: OutlinedButton(
                  key: const ValueKey('open-bill'),
                  style: OutlinedButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 12)),
                  onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => BillPage(billId: bill.id))),
                  child: FittedBox(child: Text('Bill ${money(bill.dueMinor)}', style: const TextStyle(fontFeatures: Tp.tabular))),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: FilledButton(
                  onPressed: unsent == 0
                      ? null
                      // The button itself says "All sent", with a buzz: a message
                      // here would sit over the Bill button the clerk reaches for next.
                      : () {
                          ref.read(tapProvider.notifier).send(bill.id);
                          HapticFeedback.mediumImpact();
                        },
                  child: Text(unsent == 0 ? 'All sent' : 'Send $unsent'),
                ),
              ),
            ]),
          ),
        ),
        ];
        if (!wide) return Column(children: [...menu, ...ticket]);
        return Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Expanded(child: Column(children: menu)),
          Container(
            width: 400,
            decoration: const BoxDecoration(color: Tp.inkCard, border: Border(left: BorderSide(color: Tp.inkLine))),
            child: Column(children: ticket),
          ),
        ]);
      }),
    );
  }
}
