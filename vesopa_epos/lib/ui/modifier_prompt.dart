/// The questions a product asks, put to the operator one at a time.
///
/// A gin is pressed; the till asks "single or double", then "which mixer", and
/// the answers hang off the gin on the bill. This file is that conversation and
/// nothing else — what the answers *are* is a screen, drawn by [ProgrammedGrid]
/// exactly as the sale grid is, and what happens to them afterwards belongs to
/// OrderRepository.addLine.
///
/// ---------------------------------------------------------------------------
/// The rules, and why they are the two numbers and not a pile of flags
/// ---------------------------------------------------------------------------
/// A group carries `minSelect` and `maxSelect`, and between them they are the
/// whole behaviour of the box:
///
///   min 0            Skip is offered. The operator can move on having chosen
///                    nothing, which is what "would you like a mixer?" needs.
///   min 1 or more    Skip is not offered and Done stays disabled until enough
///                    is chosen. There is no way past a compulsory question
///                    except answering it or abandoning the item.
///   max 1            The tap *is* the confirmation: the box closes and the
///                    next question opens. This is the common case and the
///                    reason a mixer costs one press rather than three.
///   max above 1      Answers accumulate and Done ends it.
///   max 0            No ceiling.
///
/// ---------------------------------------------------------------------------
/// Cancel abandons the item, it does not skip the question
/// ---------------------------------------------------------------------------
/// The operator who backs out of "how would you like the steak?" has almost
/// always pressed the wrong key, not decided the steak needs no temperature. So
/// Cancel returns null and the product never reaches the bill — rather than
/// leaving a steak on the check that the kitchen will ask about later.
library;

import 'package:flutter/material.dart';

import '../data/fonts.dart';
import '../data/local/database.dart';
import '../data/modifiers.dart';
import '../data/screens.dart';
import 'widgets/programmed_grid.dart';

/// Put every question this product asks, in order.
///
/// Returns the answers, in the order they were asked and chosen — or null if
/// the operator abandoned the item. An empty list is a real answer: every
/// question was skippable and was skipped.
Future<List<Product>?> askModifiers(
  BuildContext context, {
  required List<ModifierGroup> groups,
  required ScreenSet screens,
  required Map<int, Product> products,
  required String itemName,
  // A modifier screen is a screen, and its answers are keys like any other —
  // so a key lettered in the venue's brand font on the sale grid must not turn
  // plain the moment it is asked "which mixer?". Defaulted rather than
  // required: this dialog is reachable from more than one place, and an empty
  // library means "letter it as the app does", which is what it did before.
  FontLibrary fonts = FontLibrary.empty,
}) async {
  final chosen = <Product>[];

  for (final group in groups) {
    // A group nobody has laid out asks nothing. The till moves on rather than
    // opening an empty box in front of a queue — the same decision the server
    // makes when it reports such a group as "empty" in the back office.
    //
    // Matched on the surface as well as the id: a group pointing at a *sale*
    // screen would otherwise open the whole menu as a modifier prompt, with a
    // Pay key in it. The back office cannot produce that, which is exactly why
    // it is worth refusing here rather than trusting.
    final screen = screens.surfaceById(group.screenId, ScreenSurface.modifier);
    if (screen == null || !_hasAnswers(screen, products)) continue;

    if (!context.mounted) return null;
    final answers = await showDialog<List<Product>>(
      context: context,
      // A compulsory question cannot be dismissed by tapping beside it. The
      // operator has to answer it or abandon the item, and a barrier tap is
      // neither.
      barrierDismissible: false,
      builder: (_) => _ModifierDialog(
        group: group,
        screen: screen,
        screens: screens,
        products: products,
        itemName: itemName,
        fonts: fonts,
      ),
    );

    if (answers == null) return null; // abandoned
    chosen.addAll(answers);
  }

  return chosen;
}

/// Whether this screen has anything on it the operator could actually pick.
///
/// A screen of blanks, or one whose every product has since been deleted from
/// the catalogue, is a box with nothing to press.
bool _hasAnswers(TillScreen screen, Map<int, Product> products) {
  for (final button in screen.buttons) {
    if (button.kind == ScreenButtonKind.product &&
        products.containsKey(button.pluId)) {
      return true;
    }
  }
  return false;
}

class _ModifierDialog extends StatefulWidget {
  const _ModifierDialog({
    required this.group,
    required this.screen,
    required this.screens,
    required this.products,
    required this.itemName,
    required this.fonts,
  });

  final ModifierGroup group;
  final TillScreen screen;
  final ScreenSet screens;
  final Map<int, Product> products;
  final String itemName;
  final FontLibrary fonts;

  @override
  State<_ModifierDialog> createState() => _ModifierDialogState();
}

class _ModifierDialogState extends State<_ModifierDialog> {
  final _chosen = <Product>[];

  ModifierGroup get _group => widget.group;

  void _pick(Product answer) {
    // The one-answer case never accumulates: the tap is the answer and the box
    // is done. Doing this before the ceiling check matters — a second tap on a
    // max-1 group would otherwise be silently ignored rather than closing.
    if (_group.closesOnFirstPick) {
      Navigator.of(context).pop([answer]);
      return;
    }

    // At the ceiling, further taps do nothing rather than quietly replacing an
    // earlier choice. The operator can take one off and pick again, which is
    // the only reading of a tap that cannot lose an answer they meant.
    if (!_group.canTakeMore(_chosen.length)) return;

    setState(() => _chosen.add(answer));
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final enough = _group.satisfiedBy(_chosen.length);
    final media = MediaQuery.of(context);

    return Dialog(
      insetPadding: const EdgeInsets.all(24),
      child: ConstrainedBox(
        // Sized to the prompt, not to the screen. A four-key box stretched
        // across a 22" till is four keys a thumb has to travel between.
        constraints: BoxConstraints(
          maxWidth: 720,
          maxHeight: media.size.height * 0.8,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 18, 20, 6),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    _group.name,
                    style: theme.textTheme.titleLarge?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 2),
                  // Which item this is about. On a busy bar the box arrives a
                  // beat after the key was pressed, and "Mixers" alone does not
                  // say which drink it belongs to.
                  Text(
                    _subtitle(),
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.textTheme.bodySmall?.color?.withValues(
                        alpha: 0.7,
                      ),
                    ),
                  ),
                ],
              ),
            ),

            Flexible(
              child: ProgrammedGrid(
                screen: widget.screen,
                screens: widget.screens,
                products: widget.products,
                fonts: widget.fonts,
                onProduct: _pick,
                // A modifier screen has no page or function keys — the back
                // office does not offer them on this surface. Ignored rather
                // than crashed on, so a layout copied from a sale screen before
                // that rule existed still opens.
                onPage: (_) {},
                onFunction: (_) {},
                // Nor a question inside a question: the back office refuses to
                // save one, and a prompt on top of a prompt would have no way
                // back to the bill underneath either of them.
                onModifier: (_) {},
              ),
            ),

            if (_chosen.isNotEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final (i, answer) in _chosen.indexed)
                      InputChip(
                        label: Text(answer.name),
                        // Removing is how a wrong answer is corrected, and it
                        // is by index rather than by product: the same answer
                        // may legitimately be chosen twice.
                        onDeleted: () => setState(() => _chosen.removeAt(i)),
                      ),
                  ],
                ),
              ),

            const Divider(height: 24),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
              child: Row(
                children: [
                  TextButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: const Text('Cancel item'),
                  ),
                  const Spacer(),
                  // Offered only where it means something. A Skip on a
                  // compulsory question would be a key that looks like a way
                  // out and is not.
                  if (_group.skippable && _chosen.isEmpty)
                    TextButton(
                      onPressed: () => Navigator.of(context).pop(<Product>[]),
                      child: const Text('Skip'),
                    ),
                  if (!_group.closesOnFirstPick) ...[
                    const SizedBox(width: 8),
                    FilledButton(
                      onPressed: enough
                          ? () => Navigator.of(context).pop([..._chosen])
                          : null,
                      child: Text(
                        _chosen.isEmpty ? 'Done' : 'Done (${_chosen.length})',
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// What the box is asking for, said in the fewest words that answer "why is
  /// this in front of me and what will make it go away".
  String _subtitle() {
    final item = widget.itemName;
    if (_group.closesOnFirstPick) return 'For $item — pick one';
    if (_group.unlimited) {
      return _group.skippable
          ? 'For $item — pick any, or skip'
          : 'For $item — pick at least ${_group.minSelect}';
    }
    if (_group.skippable) {
      return 'For $item — up to ${_group.maxSelect}, or skip';
    }
    return 'For $item — ${_group.minSelect} to ${_group.maxSelect}';
  }
}
