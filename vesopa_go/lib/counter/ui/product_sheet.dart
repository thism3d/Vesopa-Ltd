/// An item that needs a choice before it goes on: a portion (Pint / Half),
/// a size, a measure and mixer, how it's cooked, or the courses of a set
/// menu. Every choice on one sheet, then how many, then Add -- the shape
/// TouchPoint uses, with the price updating as you choose.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:vesopa_go/data/models.dart';
import 'package:vesopa_go/ui/theme.dart';

typedef Picked = ({List<Choice> choices, int quantity});

Future<Picked?> pickOptions(BuildContext context, Product product) => showModalBottomSheet<Picked>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      useSafeArea: true,
      builder: (_) => _ProductSheet(product: product),
    );

class _ProductSheet extends StatefulWidget {
  const _ProductSheet({required this.product});
  final Product product;
  @override
  State<_ProductSheet> createState() => _ProductSheetState();
}

class _ProductSheetState extends State<_ProductSheet> {
  late final List<Choice?> _picked = [
    // A portion starts on the standard one (a pint is a pint); a real choice
    // (how it's cooked, which starter) starts empty, so it is never skipped.
    for (final g in widget.product.options) g.required && _portion.hasMatch(g.name) ? g.choices.first : null,
  ];
  static final _portion = RegExp('portion|size|measure', caseSensitive: false);
  int _qty = 1;

  bool get _ready => [for (final (i, g) in widget.product.options.indexed) !g.required || _picked[i] != null].every((v) => v);
  int get _unit => widget.product.priceMinor + _picked.fold(0, (s, c) => s + (c?.priceMinor ?? 0));

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final p = widget.product;
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text(p.name, textAlign: TextAlign.center, style: t.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
        if (p.allergens.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text('Allergens: ${p.allergens.join(', ')}', textAlign: TextAlign.center, style: t.bodySmall?.copyWith(color: Tp.amber)),
          ),
        Flexible(
          child: ListView(shrinkWrap: true, children: [
            for (final (i, g) in p.options.indexed) ...[
              const SizedBox(height: 16),
              Text(g.required ? g.name : '${g.name} (optional)', style: t.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
              const SizedBox(height: 8),
              _ChoiceGrid(
                group: g,
                picked: _picked[i],
                onPick: (c) {
                  HapticFeedback.selectionClick();
                  setState(() => _picked[i] = _picked[i] == c && !g.required ? null : c);
                },
              ),
            ],
          ]),
        ),
        const SizedBox(height: 20),
        Row(children: [
          _Step(icon: Icons.remove_rounded, onTap: _qty > 1 ? () => setState(() => _qty--) : null),
          Expanded(
            child: Text('$_qty', textAlign: TextAlign.center, style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w800, fontFeatures: Tp.tabular)),
          ),
          _Step(icon: Icons.add_rounded, onTap: _qty < 99 ? () => setState(() => _qty++) : null),
        ]),
        const SizedBox(height: 14),
        FilledButton(
          key: const ValueKey('add'),
          onPressed: _ready ? () => Navigator.pop(context, (choices: [for (final c in _picked) ?c], quantity: _qty)) : null,
          child: Text(_ready ? 'Add  ${money(_unit * _qty)}' : 'Choose ${p.options[_picked.indexOf(null)].name.toLowerCase()}'),
        ),
      ]),
    );
  }
}

class _ChoiceGrid extends StatelessWidget {
  const _ChoiceGrid({required this.group, required this.picked, required this.onPick});
  final OptionGroup group;
  final Choice? picked;
  final ValueChanged<Choice> onPick;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return LayoutBuilder(builder: (context, box) {
      // Two across on a phone, more on a tablet; long names (a set menu's
      // dishes) one to a row so they never truncate.
      final long = group.choices.any((c) => c.name.length > 14);
      final across = long ? (box.maxWidth > 560 ? 2 : 1) : (box.maxWidth > 560 ? 4 : 2);
      final w = (box.maxWidth - (across - 1) * 8) / across;
      return Wrap(spacing: 8, runSpacing: 8, children: [
        for (final c in group.choices)
          SizedBox(
            width: w,
            child: Material(
              color: picked == c ? Tp.lime : scheme.surfaceContainer,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(14),
                side: BorderSide(color: picked == c ? Tp.lime : scheme.outlineVariant, width: 1.5),
              ),
              child: InkWell(
                borderRadius: BorderRadius.circular(14),
                onTap: () => onPick(c),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: Tp.target),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                    child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                      Text(c.name,
                          textAlign: TextAlign.center,
                          style: TextStyle(fontWeight: FontWeight.w700, color: picked == c ? Tp.ink : scheme.onSurface)),
                      if (c.priceMinor != 0)
                        Text('${c.priceMinor > 0 ? '+' : '−'}${money(c.priceMinor.abs())}',
                            style: TextStyle(fontSize: 12, fontFeatures: Tp.tabular, color: picked == c ? Tp.ink : scheme.onSurface.withValues(alpha: 0.7))),
                    ]),
                  ),
                ),
              ),
            ),
          ),
      ]);
    });
  }
}

class _Step extends StatelessWidget {
  const _Step({required this.icon, this.onTap});
  final IconData icon;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => SizedBox.square(
        dimension: Tp.target,
        child: IconButton.filledTonal(onPressed: onTap, icon: Icon(icon)),
      );
}
