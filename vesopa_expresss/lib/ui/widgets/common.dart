/// The small pieces every kiosk screen is built from.
library;

import 'package:flutter/material.dart';

import '../../data/api.dart';
import '../theme.dart';

/// A dish's picture, or a calm placeholder where there is none.
///
/// A kiosk menu with one missing picture should look like a menu with a
/// plain tile in it, not like a broken page -- and the network is not always
/// there when a picture is asked for.
class NetImage extends StatelessWidget {
  const NetImage(this.url, {super.key, this.fit = BoxFit.cover, this.icon = Icons.restaurant});

  final String? url;
  final BoxFit fit;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final resolved = ExpressApi.imageUrl(url);
    final placeholder = _Placeholder(icon: icon);
    if (resolved == null) return placeholder;
    return Image.network(
      resolved,
      fit: fit,
      gaplessPlayback: true,
      errorBuilder: (_, _, _) => placeholder,
      loadingBuilder: (context, child, progress) => progress == null ? child : placeholder,
    );
  }
}

class _Placeholder extends StatelessWidget {
  const _Placeholder({required this.icon});
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final skin = XpSkin.of(context);
    return Container(
      color: skin.chip,
      alignment: Alignment.center,
      child: Icon(icon, size: 44, color: skin.contrast ? Xp.lime : Xp.limeDeep.withValues(alpha: .55)),
    );
  }
}

/// A small rounded label: "Popular", "Sold out", "Vegan".
class Pill extends StatelessWidget {
  const Pill(this.text, {super.key, this.color, this.textColor, this.icon});

  final String text;
  final Color? color;
  final Color? textColor;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final skin = XpSkin.of(context);
    final bg = color ?? skin.chip;
    final fg = textColor ?? Xp.onColor(bg);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[Icon(icon, size: 15, color: fg), const SizedBox(width: 4)],
          Text(
            text,
            style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: fg, height: 1.1),
          ),
        ],
      ),
    );
  }
}

/// Minus, the number, plus -- at a size a thumb can hit.
class QtyStepper extends StatelessWidget {
  const QtyStepper({
    super.key,
    required this.qty,
    required this.onChanged,
    this.min = 0,
    this.max = 20,
    this.size = 56,
  });

  final int qty;
  final ValueChanged<int> onChanged;
  final int min;
  final int max;
  final double size;

  @override
  Widget build(BuildContext context) {
    final skin = XpSkin.of(context);
    Widget button(IconData icon, VoidCallback? onTap, String label) => Semantics(
      button: true,
      label: label,
      child: Material(
        color: onTap == null ? skin.line.withValues(alpha: .5) : skin.chip,
        shape: const CircleBorder(),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: SizedBox(
            width: size,
            height: size,
            child: Icon(icon, size: size * .46, color: skin.ink),
          ),
        ),
      ),
    );
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        button(qty <= 1 && min == 0 ? Icons.delete_outline : Icons.remove,
            qty > min ? () => onChanged(qty - 1) : null, 'Fewer'),
        SizedBox(
          width: size * .9,
          child: Text(
            '$qty',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: size * .42, fontWeight: FontWeight.w800, color: skin.ink),
          ),
        ),
        button(Icons.add, qty < max ? () => onChanged(qty + 1) : null, 'More'),
      ],
    );
  }
}

/// Numbers, drawn big, for a passcode typed by somebody leaning over a kiosk.
class DigitPad extends StatelessWidget {
  const DigitPad({super.key, required this.onDigit, required this.onBack, this.onOk, this.okLabel = 'OK'});

  final ValueChanged<String> onDigit;
  final VoidCallback onBack;
  final VoidCallback? onOk;
  final String okLabel;

  @override
  Widget build(BuildContext context) {
    final skin = XpSkin.of(context);
    Widget key(Widget child, VoidCallback? onTap, {Color? color}) => Padding(
      padding: const EdgeInsets.all(6),
      child: Material(
        color: color ?? skin.card,
        borderRadius: BorderRadius.circular(Xp.radiusSmall),
        child: InkWell(
          borderRadius: BorderRadius.circular(Xp.radiusSmall),
          onTap: onTap,
          child: SizedBox(width: 92, height: 76, child: Center(child: child)),
        ),
      ),
    );
    Text digit(String d) =>
        Text(d, style: TextStyle(fontSize: 30, fontWeight: FontWeight.w700, color: skin.ink));
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final row in const [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']])
          Row(mainAxisSize: MainAxisSize.min, children: [
            for (final d in row) key(digit(d), () => onDigit(d)),
          ]),
        Row(mainAxisSize: MainAxisSize.min, children: [
          key(Icon(Icons.backspace_outlined, color: skin.ink), onBack),
          key(digit('0'), () => onDigit('0')),
          key(
            Text(okLabel, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: Xp.ink)),
            onOk,
            color: onOk == null ? skin.line : Xp.lime,
          ),
        ]),
      ],
    );
  }
}

/// A letter keyboard for a first name. Drawn by the app, because the
/// operating system's touch keyboard on a kiosk opens over the thing being
/// typed into and has a key that leaves the app.
class LetterBoard extends StatelessWidget {
  const LetterBoard({super.key, required this.onKey, required this.onBack});

  final ValueChanged<String> onKey;
  final VoidCallback onBack;

  static const _rows = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];

  @override
  Widget build(BuildContext context) {
    final skin = XpSkin.of(context);
    return LayoutBuilder(builder: (context, box) {
      final keyW = ((box.maxWidth - 20 * 2) / 10).clamp(38.0, 84.0);
      Widget key(Widget child, VoidCallback onTap, {double flex = 1}) => Padding(
        padding: const EdgeInsets.all(4),
        child: Material(
          color: skin.card,
          borderRadius: BorderRadius.circular(12),
          child: InkWell(
            borderRadius: BorderRadius.circular(12),
            onTap: onTap,
            child: SizedBox(width: keyW * flex - 8, height: 64, child: Center(child: child)),
          ),
        ),
      );
      Text letter(String l) =>
          Text(l, style: TextStyle(fontSize: 24, fontWeight: FontWeight.w700, color: skin.ink));
      return Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final row in _rows)
            Row(mainAxisSize: MainAxisSize.min, children: [
              for (final l in row.split('')) key(letter(l), () => onKey(l)),
              if (row == _rows.last)
                key(Icon(Icons.backspace_outlined, color: skin.ink), onBack, flex: 1.6),
            ]),
          Row(mainAxisSize: MainAxisSize.min, children: [
            key(letter('-'), () => onKey('-')),
            key(letter("'"), () => onKey("'")),
            key(const SizedBox.shrink(), () => onKey(' '), flex: 5),
          ]),
        ],
      );
    });
  }
}

/// A yes/no question in the kiosk's own style.
Future<bool> askYesNo(
  BuildContext context, {
  required String title,
  required String body,
  required String yes,
  required String no,
  bool danger = false,
}) async {
  final answer = await showDialog<bool>(
    context: context,
    builder: (context) {
      final skin = XpSkin.of(context);
      return Dialog(
        backgroundColor: skin.card,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Xp.radius)),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 520),
          child: Padding(
            padding: const EdgeInsets.all(28),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(title, style: Theme.of(context).textTheme.headlineSmall),
                const SizedBox(height: 10),
                Text(body, style: Theme.of(context).textTheme.bodyLarge?.copyWith(color: skin.inkSoft)),
                const SizedBox(height: 24),
                Row(children: [
                  Expanded(
                    child: OutlinedButton(onPressed: () => Navigator.pop(context, false), child: Text(no)),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: FilledButton(
                      style: danger
                          ? FilledButton.styleFrom(backgroundColor: Xp.danger, foregroundColor: Colors.white)
                          : null,
                      onPressed: () => Navigator.pop(context, true),
                      child: Text(yes),
                    ),
                  ),
                ]),
              ],
            ),
          ),
        ),
      );
    },
  );
  return answer ?? false;
}
