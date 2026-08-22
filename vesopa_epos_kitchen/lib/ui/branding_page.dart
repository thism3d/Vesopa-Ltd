import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/kitchen_branding.dart';
import '../data/providers.dart';
import 'splash_screen.dart';
import 'theme.dart';
import 'widgets/on_screen_keyboard.dart';
import 'widgets/password_prompt.dart';

/// White-label branding, edited from a screen on the wall.
///
/// The same fields the back office edits, and the same values: this is
/// **venue-wide**, so a change made here reaches every kitchen screen on the
/// site within a second or two. That is the point of it — a manager standing in
/// the kitchen with the screen in front of them should not have to walk to an
/// office to fix a colour they can see is wrong from where they are.
///
/// It costs the kitchen password, asked for at the moment of saving rather than
/// on the way in. Asking on the way in would make a manager type a password to
/// *look*, and looking is the common case: half the visits here are somebody
/// checking what the venue is currently set to.
///
/// The logo is the one thing not settable from here. Uploading a file needs a
/// file browser, and a kiosk running full screen with no keyboard is a poor
/// place to find one — so it stays in the back office, which is also the only
/// place that can write files at all.
Future<void> showKitchenBranding(BuildContext context) => showDialog<void>(
  context: context,
  builder: (_) => const Dialog(child: _BrandingSheet()),
);

class _BrandingSheet extends ConsumerStatefulWidget {
  const _BrandingSheet();

  @override
  ConsumerState<_BrandingSheet> createState() => _BrandingSheetState();
}

/// Which field the on-screen keyboard is typing into.
///
/// One keyboard for two fields rather than one that follows focus — the same
/// choice the sign-in page makes, and for the same reason: a keyboard that
/// moves as focus moves also moves when it does not, and on glass the
/// difference between "I tapped the field" and "I tapped past it" is a few
/// pixels.
enum _Field { name, tagline }

class _BrandingSheetState extends ConsumerState<_BrandingSheet> {
  final _name = TextEditingController();
  final _tagline = TextEditingController();

  _Field _active = _Field.name;

  /// The edit in progress. Applied to the venue only on Save.
  late KitchenBranding _draft;

  /// What it was when this opened, so Revert has something to revert to.
  late KitchenBranding _saved;

  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _saved = ref.read(kitchenSessionProvider).value?.branding ??
        KitchenBranding.standard;
    _reset();
  }

  void _reset() {
    _draft = _saved;
    _name.text = _draft.appName;
    _tagline.text = _draft.tagline;
    setState(() => _error = null);
  }

  @override
  void dispose() {
    _name.dispose();
    _tagline.dispose();
    super.dispose();
  }

  TextEditingController get _controller =>
      _active == _Field.name ? _name : _tagline;

  /// The draft, with whatever is currently in the two text fields.
  ///
  /// Read on demand rather than pushed into `_draft` on every keystroke: the
  /// preview below rebuilds from this, and a `setState` per character on a
  /// screen this size is a stutter somebody will feel through the glass.
  KitchenBranding get _current => _draft.copyWith(
    appName: _name.text.trim(),
    tagline: _tagline.text.trim(),
  );

  Future<void> _save() async {
    final password = await askForKitchenPassword(
      context,
      ref,
      icon: Icons.palette_outlined,
      title: 'Save branding for this venue?',
      explanation:
          'This changes every kitchen screen in the venue, not just this one. '
          'Enter the kitchen password to confirm.',
      confirmLabel: 'Save branding',
    );
    if (password == null || !mounted) return;

    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      await ref
          .read(kitchenSessionProvider.notifier)
          .saveBranding(_current, password: password);

      if (!mounted) return;
      // Re-read rather than trusting the draft: the server clamps the hold and
      // drops a colour it could not parse, and this panel should settle on the
      // value the wall will actually use.
      setState(() {
        _saved = ref.read(kitchenSessionProvider).value?.branding ?? _current;
        _busy = false;
      });
      _reset();
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _busy = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 900, maxHeight: 780),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          AppBar(
            title: const Text('Start screen & branding'),
            automaticallyImplyLeading: false,
            actions: [
              IconButton(
                icon: const Icon(Icons.close),
                onPressed: _busy ? null : () => Navigator.of(context).pop(),
              ),
            ],
          ),
          Flexible(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(18, 12, 18, 18),
              children: [
                Text(
                  'This is the venue’s, not this machine’s — every kitchen '
                  'screen on the site follows it. Leave a box empty and the '
                  'screen falls back: to the venue’s receipt logo, then to the '
                  'built-in Vesopa mark.',
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Kds.inkMuted,
                  ),
                ),
                const SizedBox(height: 14),

                _Preview(branding: _current),
                const SizedBox(height: 16),

                const _SectionTitle('What the screen calls itself'),
                TextField(
                  controller: _name,
                  maxLength: 40,
                  onTap: () => setState(() => _active = _Field.name),
                  onChanged: (_) => setState(() {}),
                  decoration: InputDecoration(
                    hintText: KitchenBranding.fallbackName,
                    labelText: 'Name',
                    filled: _active == _Field.name,
                  ),
                ),
                const SizedBox(height: 6),
                TextField(
                  controller: _tagline,
                  maxLength: 80,
                  onTap: () => setState(() => _active = _Field.tagline),
                  onChanged: (_) => setState(() {}),
                  decoration: InputDecoration(
                    hintText: 'The venue’s name',
                    labelText: 'The line under it',
                    filled: _active == _Field.tagline,
                  ),
                ),

                const Divider(height: 26),
                const _SectionTitle('Colours'),
                _ColourRow(
                  label: 'Background',
                  colour: _current.background ?? Kds.chromeHeader,
                  isSet: _current.background != null,
                  onPick: (c) => setState(() => _draft = _draft.copyWith(
                    background: c,
                    clearBackground: c == null,
                  )),
                ),
                _ColourRow(
                  label: 'Accent',
                  colour: _current.accent ?? Kds.brand,
                  isSet: _current.accent != null,
                  onPick: (c) => setState(() => _draft = _draft.copyWith(
                    accent: c,
                    clearAccent: c == null,
                  )),
                ),

                const Divider(height: 26),
                const _SectionTitle('The start screen'),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  value: _draft.splashEnabled,
                  onChanged: (on) => setState(
                    () => _draft = _draft.copyWith(splashEnabled: on),
                  ),
                  title: const Text('Show it when a screen launches'),
                  subtitle: const Text(
                    'The board is fetched behind it either way, so this never '
                    'delays an order arriving.',
                    style: TextStyle(fontSize: 12.5),
                  ),
                ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  value: _draft.showPoweredBy,
                  onChanged: (on) => setState(
                    () => _draft = _draft.copyWith(showPoweredBy: on),
                  ),
                  title: const Text('Show “Powered by Vesopa” on it'),
                ),
                if (_draft.splashEnabled) ...[
                  const SizedBox(height: 6),
                  Text(
                    'Hold it on screen for ${_draft.splashHold.inMilliseconds}ms '
                    'once the animation has finished.',
                    style: const TextStyle(color: Kds.inkMuted, fontSize: 12.5),
                  ),
                  Slider(
                    value: _draft.splashHold.inMilliseconds
                        .clamp(0, 6000)
                        .toDouble(),
                    min: 0,
                    max: 6000,
                    divisions: 24,
                    label: '${_draft.splashHold.inMilliseconds}ms',
                    onChanged: (ms) => setState(
                      () => _draft = _draft.copyWith(
                        splashHold: Duration(milliseconds: ms.round()),
                      ),
                    ),
                  ),
                ],

                const Divider(height: 26),
                const _SectionTitle('The logo'),
                Text(
                  _draft.logoUrl == null
                      ? 'No logo has been set for this venue, so the screens '
                            'show the built-in Vesopa Kitchen mark. Upload one '
                            'in the back office, under Kitchen screens.'
                      : 'Set in the back office. Change or remove it there, '
                            'under Kitchen screens.',
                  style: const TextStyle(color: Kds.inkMuted, fontSize: 12.5),
                ),

                if (_error != null) ...[
                  const SizedBox(height: 12),
                  Text(
                    _error!,
                    style: const TextStyle(color: Kds.late, height: 1.35),
                  ),
                ],

                const SizedBox(height: 14),
                OnScreenKeyboard(
                  controller: _controller,
                  onSubmit: () => setState(
                    () => _active =
                        _active == _Field.name ? _Field.tagline : _Field.name,
                  ),
                  submitLabel: 'Next',
                ),
              ],
            ),
          ),
          const Divider(height: 1),
          Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: _busy ? null : _reset,
                  child: const Text('Revert'),
                ),
                const SizedBox(width: 8),
                FilledButton.icon(
                  onPressed: _busy ? null : _save,
                  icon: _busy
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Colors.white,
                          ),
                        )
                      : const Icon(Icons.check),
                  label: const Text('Save for the venue'),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The start screen, at a size that fits in a panel.
///
/// The real widget rather than a drawing of one, so what is previewed cannot
/// drift from what the wall shows — including the animation, which replays on
/// every edit and is the fastest way to see whether an accent has any contrast
/// against the background somebody has just chosen.
class _Preview extends StatelessWidget {
  const _Preview({required this.branding});

  final KitchenBranding branding;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _SectionTitle('As the wall will see it'),
        const SizedBox(height: 6),
        ClipRRect(
          borderRadius: BorderRadius.circular(10),
          child: AspectRatio(
            aspectRatio: 16 / 9,
            child: branding.splashEnabled
                ? FittedBox(
                    fit: BoxFit.contain,
                    // Drawn at a real screen's size and scaled down, so the
                    // proportions are the wall's rather than this panel's.
                    child: SizedBox(
                      width: 1280,
                      height: 720,
                      child: SplashScreen(
                        // Keyed on the branding so any edit restarts the
                        // animation — which is the preview doing its job.
                        key: ValueKey(branding.toJson().toString()),
                        branding: branding,
                        onDone: () {},
                      ),
                    ),
                  )
                : Container(
                    color: Kds.surface,
                    alignment: Alignment.center,
                    child: const Text(
                      'The start screen is switched off — screens go straight '
                      'to the board.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: Kds.inkMuted),
                    ),
                  ),
          ),
        ),
      ],
    );
  }
}

/// One colour, and the swatches it may be.
///
/// A fixed palette rather than a colour wheel. A wheel on a touch screen picks
/// a colour nobody meant with a fingertip two millimetres wide, and the failure
/// it produces — an accent with no contrast against the background — is one
/// that is only discovered from across a kitchen. Every swatch here is one that
/// works.
class _ColourRow extends StatelessWidget {
  const _ColourRow({
    required this.label,
    required this.colour,
    required this.isSet,
    required this.onPick,
  });

  final String label;
  final Color colour;
  final bool isSet;

  /// Null means "use the built-in colour".
  final ValueChanged<Color?> onPick;

  static const _swatches = <Color>[
    Color(0xFF111111),
    Color(0xFF1E2430),
    Color(0xFF14312B),
    Color(0xFF2B1E3A),
    Color(0xFF3A1E1E),
    Color(0xFFF4F6FA),
    Kds.brand,
    Color(0xFF4B57E8),
    Color(0xFF21A73E),
    Color(0xFFCE7A0A),
    Color(0xFFD03227),
    Color(0xFF00A6A6),
  ];

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 110,
            child: Text(label, style: const TextStyle(color: Kds.inkMuted)),
          ),
          Expanded(
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final swatch in _swatches)
                  _Swatch(
                    colour: swatch,
                    selected: isSet && swatch.toARGB32() == colour.toARGB32(),
                    onTap: () => onPick(swatch),
                  ),
                // Always offered, and always last: the way back to the built-in
                // look must not depend on remembering what it was.
                TextButton(
                  onPressed: isSet ? () => onPick(null) : null,
                  child: const Text('Built-in'),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Swatch extends StatelessWidget {
  const _Swatch({
    required this.colour,
    required this.selected,
    required this.onTap,
  });

  final Color colour;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        width: 44,
        height: 36,
        decoration: BoxDecoration(
          color: colour,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(
            color: selected ? Kds.selected : Kds.surface,
            width: selected ? 3 : 1,
          ),
        ),
        child: selected
            ? Icon(Icons.check, size: 18, color: Kds.inkOn(colour))
            : null,
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 4),
    child: Text(
      text,
      style: Theme.of(
        context,
      ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
    ),
  );
}
