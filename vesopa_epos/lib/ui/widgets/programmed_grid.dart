import 'package:flutter/material.dart';

import '../../data/commerce.dart';
import '../../data/fonts.dart';
import '../../data/local/database.dart';
import '../../data/pricing_engine.dart';
import '../../data/screens.dart';
import '../layout.dart';
import '../theme.dart';
import 'basket_panel.dart' show money;
import 'offer_chip.dart';

/// A venue's own sale screen, drawn.
///
/// The alternative to the catalogue-driven grid the till has always shown. Which
/// one a venue gets is `TillSettings.homeScreenId`: null means the built-in
/// Default, and the sale page keeps its old rendering. See
/// `docs/screen-programming.md`.
///
/// **Nothing here may fail to draw.** A layout is arranged in an office, weeks
/// before a clerk stands in front of it, and everything it points at can be
/// deleted in between — the product, the screen a button jumps to, or a function
/// this build has never heard of. Each of those renders as a key that says what
/// is wrong and refuses the press, because a blank key is one a clerk presses
/// twice before asking anybody, and a crash is a till that has stopped taking
/// money.
class ProgrammedGrid extends StatelessWidget {
  const ProgrammedGrid({
    super.key,
    required this.screen,
    required this.screens,
    required this.products,
    required this.onProduct,
    required this.onPage,
    required this.onFunction,
    this.showPrices = true,
    this.promotions,
    this.fonts = FontLibrary.empty,
  });

  final TillScreen screen;

  /// The whole set, so a page button can name the screen it points at without
  /// another fetch — and so a button pointing at a deleted one can say so.
  final ScreenSet screens;

  /// The catalogue, by PLU. Built once by the caller rather than searched per
  /// button: a screen is up to 120 keys and a catalogue is thousands of rows.
  final Map<int, Product> products;

  final void Function(Product) onProduct;
  final void Function(TillScreen) onPage;
  final void Function(String functionKey) onFunction;

  final bool showPrices;

  /// The offers running now, so a programmed key can flash one.
  ///
  /// Null on a venue with no promotions, and optional so the grid can be drawn
  /// without one. A product on a programmed screen is the same product as on
  /// the catalogue grid, and an offer that shows on one screen and not the
  /// other is a clerk quoting the wrong price on whichever they are standing
  /// in front of.
  final PricingEngine? promotions;

  /// The venue's fonts, for keys that have been given one of their own.
  ///
  /// Passed in rather than watched here, like the catalogue and the screen set,
  /// so this widget stays something a test can build with a literal.
  ///
  /// The *venue's* font is not in here and does not need to be: it is on the
  /// theme, so a key that asks for nothing inherits it the way every other
  /// piece of text in the app does. Only a key with a font of its own overrides.
  final FontLibrary fonts;

  @override
  Widget build(BuildContext context) {
    final pal = PayPalette.of(context);
    final covered = screen.covered;

    return Padding(
      padding: EdgeInsets.all(context.isPhone ? 8 : 12),
      child: LayoutBuilder(
        builder: (context, box) {
          // Cells sized from the space actually available, so the same layout
          // works on a 1920 counter till and a 1280 handheld. This is the whole
          // reason a button is a grid cell rather than a pixel rectangle — see
          // the design doc, §2.
          const gap = 8.0;
          final cellW = (box.maxWidth - gap * (screen.cols - 1)) / screen.cols;
          final cellH = (box.maxHeight - gap * (screen.rows - 1)) / screen.rows;

          final keys = <Widget>[];
          for (var r = 0; r < screen.rows; r++) {
            for (var c = 0; c < screen.cols; c++) {
              if (covered.contains('$r:$c')) continue;
              final button = screen.at(r, c);
              if (button == null) continue;
              // A space the venue set aside and has not filled in yet.
              // It holds its ground — the cells under its span are already
              // skipped as covered — and draws nothing. A key a clerk can
              // see and cannot press is worse than a gap.
              if (button.kind == ScreenButtonKind.blank) continue;

              keys.add(
                Positioned(
                  left: c * (cellW + gap),
                  top: r * (cellH + gap),
                  width: cellW * button.colSpan + gap * (button.colSpan - 1),
                  height: cellH * button.rowSpan + gap * (button.rowSpan - 1),
                  child: _Key(
                    button: button,
                    screens: screens,
                    product: button.pluId == null
                        ? null
                        : products[button.pluId],
                    promotion: _offerFor(button),
                    pal: pal,
                    fontFamily: fonts.familyFor(button.fontFamily),
                    showPrices: showPrices,
                    onProduct: onProduct,
                    onPage: onPage,
                    onFunction: onFunction,
                  ),
                ),
              );
            }
          }

          return Stack(children: keys);
        },
      ),
    );
  }

  /// The offer covering a key's product, if it has one and there is an offer.
  Promotion? _offerFor(ScreenButton button) {
    final engine = promotions;
    if (engine == null || button.kind != ScreenButtonKind.product) return null;
    final product = button.pluId == null ? null : products[button.pluId];
    if (product == null) return null;
    return engine.badgeFor(
      pluid: product.pluId,
      department: product.departmentName,
      group: product.groupName,
    );
  }
}

class _Key extends StatelessWidget {
  const _Key({
    required this.button,
    required this.screens,
    required this.product,
    required this.promotion,
    required this.pal,
    required this.fontFamily,
    required this.showPrices,
    required this.onProduct,
    required this.onPage,
    required this.onFunction,
  });

  final ScreenButton button;
  final ScreenSet screens;
  final Product? product;

  /// The offer running on this key's product right now, if any.
  final Promotion? promotion;

  final PayPalette pal;

  /// The engine family this key is lettered in, or null to inherit the theme —
  /// which carries the venue's font, or the app's own if the venue has not
  /// chosen one. Already resolved: a font the venue deleted, or one this
  /// terminal has not finished downloading, arrives here as null. See
  /// [FontLibrary.familyFor].
  final String? fontFamily;
  final bool showPrices;

  final void Function(Product) onProduct;
  final void Function(TillScreen) onPage;
  final void Function(String) onFunction;

  /// What the key says, and what happens when it is pressed.
  ///
  /// Resolved together because they are the same question: a button whose
  /// product has been deleted has no action *and* has to say why, and working
  /// those out in two places is how they end up disagreeing.
  ({String label, String? note, VoidCallback? onTap}) get _resolved {
    switch (button.kind) {
      case ScreenButtonKind.product:
        final p = product;
        if (p == null) {
          return (
            label: button.label ?? 'Unavailable',
            note: 'Not in the catalogue',
            onTap: null,
          );
        }
        return (
          label: button.label ?? p.name,
          note: showPrices ? money(p.priceMinor) : null,
          onTap: () => onProduct(p),
        );

      case ScreenButtonKind.page:
        final target = screens.byId(button.targetScreenId);
        if (target == null) {
          return (
            label: button.label ?? 'Unavailable',
            note: 'Screen removed',
            onTap: null,
          );
        }
        return (
          label: button.label ?? target.name,
          note: '›››',
          onTap: () => onPage(target),
        );

      case ScreenButtonKind.function:
        final key = button.functionKey;
        if (key == null || key.isEmpty) {
          return (label: button.label ?? 'Unset', note: null, onTap: null);
        }
        return (
          label: button.label ?? _functionNames[key] ?? key,
          note: null,
          onTap: () => onFunction(key),
        );

      // A button from a newer release. Drawn as inert rather than dropped, so
      // the layout keeps its shape and the gap is explained — a key that simply
      // vanished would have somebody looking for it.
      // Never reached: a reserved space is skipped before a key is built for
      // it. Answered anyway rather than left to a default, so adding a kind
      // stays a compile error everywhere it has to be handled.
      case ScreenButtonKind.blank:
        return (label: '', note: null, onTap: null);
      case ScreenButtonKind.unknown:
        return (
          label: button.label ?? 'Not supported',
          note: 'Update the till',
          onTap: null,
        );
    }
  }

  /// Mirrors FUNCTION_KEYS in vesopa_server/src/screens.js.
  ///
  /// A key that is not in here still draws — as "Not supported", via the
  /// unknown branch above — so a till running an older release than the back
  /// office shows an inert key rather than failing to parse the screen.
  static const _functionNames = <String, String>{
    'qty': 'Quantity',
    'note': 'Note',
    'covers': 'Covers',
    'customer': 'Customer',
    'open_drawer': 'No sale',
    'print_bill': 'Print bill',
  };

  @override
  Widget build(BuildContext context) {
    final r = _resolved;
    final enabled = r.onTap != null;

    // The venue's colour when it has chosen one, the till's own key colour when
    // it has not — which is what keeps an unstyled screen looking like Vesopa
    // rather than looking unfinished.
    final fill = button.fill ?? pal.keyFill;
    final ink = button.ink ?? (button.fill == null ? pal.ink : Pos.inkOn(fill));

    // The picture, if this key has one. It *fills* the key rather than sitting
    // above the words — which is the change a venue that photographed its menu
    // asked for, and the reason the framing controls exist at all. See
    // [_picture] for the arithmetic and [ScreenButton.imageFit] for the model.
    final picture = _picture();

    return Opacity(
      // Dimmed rather than hidden. It still holds its place in the layout, and
      // it is still obviously a key — just one that cannot be pressed.
      opacity: enabled ? 1 : 0.55,
      child: Material(
        color: fill,
        borderRadius: BorderRadius.circular(10),
        // Which is also what clips the picture to the key's rounded corners.
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: r.onTap,
          child: Stack(
            fit: StackFit.expand,
            children: [
              // Behind everything, and outside the padding: a photograph that
              // stops 6px short of the key's edge reads as a mistake.
              ?picture,
              Container(
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(
                    color: enabled
                        ? pal.keyLine
                        : Pos.red.withValues(alpha: 0.6),
                  ),
                ),
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
                // Sized from the key rather than from the screen: the same
                // layout is drawn on a 15-inch counter panel and on a handheld,
                // so "is there room for the picture" is a question only the key
                // can answer. Below the threshold it draws exactly as it always
                // did.
                child: LayoutBuilder(
                  builder: (context, box) {
                    // An emoji still stacks above the words the way it always
                    // has. Only a *picture* takes the whole key, because only a
                    // picture is spoiled by being shrunk to a stamp.
                    final emoji = picture == null ? _emojiFace() : null;
                    final roomForMedia =
                        emoji != null &&
                        box.maxHeight >= 84 &&
                        box.maxWidth >= 84;

                    // Picture only, unless the venue asked for the name as
                    // well. A photograph of a burger is a better burger key
                    // than the word BURGER over a sliver of one — and the price
                    // goes with the name, because "just the image" means just
                    // the image. The tick in the back office brings both back.
                    final words = picture == null || button.showLabel;

                    // A size set in the back office is a wish, not a promise,
                    // and this is where the difference is settled. The same
                    // layout is drawn on a 15-inch counter panel and on a
                    // handheld: 28pt is handsome on one and taller than the
                    // whole key on the other, and a key whose label has been
                    // pushed out of sight is worse than one lettered smaller
                    // than asked. So the key's own height caps it. A label
                    // still too long for the *width* ellipsises exactly as it
                    // always has — this caps the lettering, it does not reflow
                    // the words.
                    //
                    // A key with no size of its own takes the numbers this
                    // widget has always used, untouched and uncapped. That is
                    // deliberate and it is checked by a golden: every key on
                    // every screen a venue has already programmed has no size,
                    // and a new control that quietly re-letters all of them is
                    // not a new control, it is a regression with a settings box
                    // attached.
                    final asked = button.fontSize?.toDouble();
                    final ceiling = (box.maxHeight / (roomForMedia ? 4.2 : 2.8))
                        .clamp(9.0, 48.0);
                    final size = asked == null
                        ? 14.0
                        : (asked > ceiling ? ceiling : asked);
                    final noteSize = asked == null
                        ? 11.5
                        : (size * 0.82).clamp(9.0, 20.0);

                    return Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        if (words)
                          Flexible(
                            child: _OverPicture(
                              on: picture != null,
                              child: Text(
                                r.label,
                                textAlign: TextAlign.center,
                                maxLines: roomForMedia ? 2 : 3,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  // White on a photograph, whatever the key's
                                  // own colour is: the ink was chosen to read
                                  // against the fill, and the fill is no longer
                                  // what is behind the words.
                                  color: picture != null ? Colors.white : ink,
                                  fontFamily: fontFamily,
                                  fontSize: size,
                                  fontWeight: FontWeight.w700,
                                  height: 1.15,
                                ),
                              ),
                            ),
                          ),
                        // The product's own emoji, which the catalogue grid has
                        // always shown and this one did not: a venue that
                        // decorated its menu lost every face the moment it
                        // programmed a screen, and had no way to tell why.
                        if (roomForMedia) ...[
                          const SizedBox(height: 4),
                          Flexible(fit: FlexFit.tight, child: emoji),
                        ],
                        if (words && r.note != null) ...[
                          const SizedBox(height: 2),
                          _OverPicture(
                            on: picture != null,
                            child: Text(
                              r.note!,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                color: picture != null
                                    ? Colors.white
                                    : ink.withValues(alpha: 0.75),
                                fontFamily: fontFamily,
                                // The note follows the label rather than being
                                // set outright: a price under a 24pt name
                                // should not be the same 11.5pt as one under a
                                // 12pt name.
                                fontSize: noteSize,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ],
                        // Drawn even on a picture-only key, and deliberately.
                        // An offer that is running and not shown is a clerk
                        // quoting the wrong price, which is a different order
                        // of problem from a key that looks busy.
                        if (OfferChip.forPromotion(promotion)
                            case final chip?) ...[
                          const SizedBox(height: 4),
                          FittedBox(fit: BoxFit.scaleDown, child: chip),
                        ],
                      ],
                    );
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// The key's picture, framed as the back office set it — or null.
  ///
  /// Null is the common case and has to cost nothing: most keys on most screens
  /// are a word on a colour, and that is the layout the venue arranged.
  ///
  /// The chain is the key's own picture, then the product's. Two things follow
  /// from that order and both were asked for:
  ///
  ///   * a page key can carry a picture at all — until the back office could
  ///     set one, the only way a key had a face was to be a product that had
  ///     one, so the venue that photographed its menu could not put its own
  ///     picture on the FOOD key that leads to it;
  ///   * a product key can be given a different face on one screen without
  ///     changing the product everywhere else.
  ///
  /// And the fallback is what stops the feature un-decorating every screen a
  /// venue had already programmed.
  ///
  /// The framing is three steps in this order, and the order is the contract
  /// with the back office's preview — get it wrong and the editor shows a
  /// manager something a clerk will never see:
  ///
  ///   1. lay the picture in with [ScreenButton.imageFit];
  ///   2. scale it about the centre by [ScreenButton.imageScale];
  ///   3. shift it by [ScreenButton.imageX] / [ScreenButton.imageY], as a
  ///      fraction of the *key's* own width and height.
  ///
  /// `Transform.translate` outside `Transform.scale` is what puts them in that
  /// order: the inner transform runs first. It matches CSS's
  /// `transform: translate(x%, y%) scale(s)`, which the editor uses, because
  /// CSS reads a transform list right to left.
  Widget? _picture() {
    final p = product;
    final isProduct = button.kind == ScreenButtonKind.product;
    final image = button.imageUrl?.isNotEmpty == true
        ? button.imageUrl
        : (isProduct ? p?.imageUrl : null);
    if (image == null || image.isEmpty) return null;

    return LayoutBuilder(
      builder: (context, box) => ClipRect(
        child: Transform.translate(
          offset: Offset(
            box.maxWidth * button.imageX / 100,
            box.maxHeight * button.imageY / 100,
          ),
          child: Transform.scale(
            scale: button.imageScale / 100,
            child: Image.network(
              image,
              fit: button.imageFit.boxFit,
              width: box.maxWidth,
              height: box.maxHeight,
              // A picture that will not load leaves the key exactly as a
              // product with no picture. A broken-image frame on a sale screen
              // is worse than no picture at all.
              errorBuilder: (_, _, _) => const SizedBox.shrink(),
              loadingBuilder: (context, child, progress) =>
                  progress == null ? child : const SizedBox.shrink(),
            ),
          ),
        ),
      ),
    );
  }

  /// The key's emoji, or the product's — for keys that have no picture.
  Widget? _emojiFace() {
    final p = product;
    final isProduct = button.kind == ScreenButtonKind.product;
    final ownEmoji = button.emoji?.isNotEmpty == true
        ? button.emoji
        : (isProduct ? p?.emoji : null);
    if (ownEmoji == null || ownEmoji.isEmpty) return null;

    return Center(
      child: FittedBox(
        fit: BoxFit.scaleDown,
        child: Text(ownEmoji, style: const TextStyle(fontSize: 34)),
      ),
    );
  }
}

/// Lettering that has to stay readable over a photograph.
///
/// The scrim is the whole point. Which keys need one depends on the picture
/// rather than on anything the layout knows — a white label is unreadable on a
/// pale plate and perfect on a dark one, and the same key can be both as the
/// venue changes the photograph. So every label drawn over a picture gets the
/// same quiet pill behind it, and none of them can be unreadable.
///
/// Passes the child straight through when there is no picture, so a key that
/// has always been a word on a colour is drawn by exactly the widgets it always
/// was — see the golden test.
class _OverPicture extends StatelessWidget {
  const _OverPicture({required this.on, required this.child});

  final bool on;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (!on) return child;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        child: child,
      ),
    );
  }
}
