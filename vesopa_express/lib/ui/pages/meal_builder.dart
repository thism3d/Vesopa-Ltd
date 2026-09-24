/// "Make it a meal", one step at a time.
///
/// THE McDONALD'S SHAPE, BECAUSE IT WORKS
///
/// A dish that offers a meal says so on its sheet: *On its own* or *Make it a
/// meal*, side by side, with the meal's price on it. Choosing the meal turns the
/// sheet into a short walk -- the size, if there is more than one; then one
/// question per screen, as big picture cards; then the meal as it will arrive,
/// with how many and the price. One question per screen, because a kiosk is
/// read standing up, by somebody hungry, with a queue behind them: a page of
/// four questions is a form, and forms are where orders go wrong.
///
/// A question with one answer to give moves on by itself when it is answered
/// -- the tap IS the confirmation, as it is on the till -- and a rail across the
/// top shows where the customer is and lets them go back to any step they have
/// done. Nothing about a meal's price is decided here: the server prices the
/// meal product and every answer from the catalogue (see mealsFor in
/// vesopa_server/src/menu_core.js). The figures on these cards are for showing.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/basket.dart';
import '../../data/models.dart';
import '../../data/order_flow.dart';
import '../../l10n/strings.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// The two ways to have a dish that offers a meal, on the dish's own sheet.
class MealChoice extends StatelessWidget {
  const MealChoice({super.key, required this.item, required this.s, required this.onMeal});

  final MenuItem item;
  final S s;
  final VoidCallback onMeal;

  @override
  Widget build(BuildContext context) {
    final skin = XpSkin.of(context);
    final text = Theme.of(context).textTheme;
    final from = item.mealFromMinor ?? 0;
    // What a meal is, in the venue's own words: its questions.
    final steps = <String>{
      for (final m in item.meals)
        for (final g in m.steps) g.name,
    }.join('  ·  ');

    Widget card({
      required String title,
      required String price,
      required bool lit,
      String? sub,
      IconData icon = Icons.check_circle_rounded,
      VoidCallback? onTap,
    }) =>
        Material(
            color: lit ? skin.card : Xp.lime,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(Xp.radius),
              side: BorderSide(color: lit ? skin.line : Xp.lime, width: 2),
            ),
            child: InkWell(
              borderRadius: BorderRadius.circular(Xp.radius),
              onTap: onTap,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(18, 16, 16, 16),
                child: Row(
                  children: [
                    Icon(icon, size: 34, color: lit ? skin.muted : Xp.ink),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(title,
                              style: text.titleLarge?.copyWith(color: lit ? skin.ink : Xp.ink, fontWeight: FontWeight.w800)),
                          const SizedBox(height: 2),
                          Text(price,
                              style: TextStyle(
                                  fontSize: 18, fontWeight: FontWeight.w800, color: lit ? skin.inkSoft : Xp.ink)),
                          if (sub != null && sub.isNotEmpty) ...[
                            const SizedBox(height: 4),
                            Text(sub,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: lit ? skin.muted : Xp.ink)),
                          ],
                        ],
                      ),
                    ),
                    if (onTap != null) const Icon(Icons.chevron_right_rounded, size: 34, color: Xp.ink),
                  ],
                ),
              ),
            ),
        );

    final own = card(
      title: s('on_its_own'),
      price: money(item.priceMinor),
      lit: true,
      icon: Icons.radio_button_checked_rounded,
    );
    final meal = card(
      title: s('make_it_a_meal'),
      price: '${item.meals.length > 1 ? '${s('from')} ' : ''}${money(from)}',
      lit: false,
      sub: steps,
      icon: Icons.lunch_dining_rounded,
      onTap: onMeal,
    );
    // Side by side where they fit; one above the other on a narrow sheet,
    // where side by side wrapped "Make it a meal" onto two lines and cut its
    // steps off after the first (measured at 540 x 960).
    return LayoutBuilder(
      builder: (context, box) => box.maxWidth < 600
          ? Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [meal, const SizedBox(height: 12), own])
          : Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [Expanded(child: own), const SizedBox(width: 14), Expanded(child: meal)],
            ),
    );
  }
}

/// The steps of one meal.
enum _Kind { size, question, review }

class _Step {
  const _Step(this.kind, [this.group]);
  final _Kind kind;
  final AddOnGroup? group;
}

class MealBuilder extends ConsumerStatefulWidget {
  const MealBuilder({super.key, required this.item, required this.onBack, required this.onDone});

  final MenuItem item;

  /// Back to the dish on its own.
  final VoidCallback onBack;
  final ValueChanged<BasketLine> onDone;

  @override
  ConsumerState<MealBuilder> createState() => _MealBuilderState();
}

class _MealBuilderState extends ConsumerState<MealBuilder> {
  int _size = 0;
  int _at = 0;
  int _qty = 1;

  /// The answers, per question, in the order they were given.
  final Map<int, List<int>> _picks = {};
  Timer? _advance;

  Meal get _meal => widget.item.meals[_size];

  List<_Step> get _steps => [
    if (widget.item.meals.length > 1) const _Step(_Kind.size),
    for (final g in _meal.steps) _Step(_Kind.question, g),
    const _Step(_Kind.review),
  ];

  bool _answered(AddOnGroup g) => (_picks[g.id]?.length ?? 0) >= g.min;

  bool _done(_Step step) => switch (step.kind) {
    _Kind.size => true,
    _Kind.question => _answered(step.group!) && _picks.containsKey(step.group!.id),
    _Kind.review => false,
  };

  List<AddOnOption> get _options => [
    for (final g in _meal.steps)
      for (final plu in _picks[g.id] ?? const <int>[])
        ?g.options.where((o) => o.pluId == plu).firstOrNull,
  ];

  int get _unit => _meal.priceMinor + _options.fold<int>(0, (sum, o) => sum + o.priceMinor);

  @override
  void dispose() {
    _advance?.cancel();
    super.dispose();
  }

  void _go(int to) {
    _advance?.cancel();
    setState(() => _at = to.clamp(0, _steps.length - 1));
  }

  /// A size chosen: its questions may differ from the last size's, so answers
  /// to questions the new meal does not ask are dropped.
  void _chooseSize(int i) {
    setState(() {
      _size = i;
      final asked = {for (final g in _meal.steps) g.id};
      _picks.removeWhere((id, _) => !asked.contains(id));
    });
    _advance?.cancel();
    _advance = Timer(const Duration(milliseconds: 260), () {
      if (mounted) _go(_at + 1);
    });
  }

  void _toggle(AddOnGroup g, AddOnOption o) {
    final list = _picks.putIfAbsent(g.id, () => <int>[]);
    setState(() {
      if (list.contains(o.pluId)) {
        list.remove(o.pluId);
      } else if (g.single) {
        list
          ..clear()
          ..add(o.pluId);
      } else if (list.length < g.max) {
        list.add(o.pluId);
      }
    });
    // One answer to give, and it has been given: on to the next, after a beat
    // long enough to see the tick land.
    if (g.single && list.isNotEmpty) {
      _advance?.cancel();
      _advance = Timer(const Duration(milliseconds: 320), () {
        if (mounted) _go(_at + 1);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(orderFlowProvider.select((f) => f.s));
    final skin = XpSkin.of(context);
    final text = Theme.of(context).textTheme;
    final steps = _steps;
    final at = _at.clamp(0, steps.length - 1);
    final step = steps[at];
    final item = widget.item;

    final Widget body = switch (step.kind) {
      _Kind.size => _Cards(
        title: s('choose_size'),
        rule: null,
        cards: [
          for (final (i, m) in item.meals.indexed)
            _CardData(
              key: 'size-${m.pluId}',
              title: m.label ?? m.name,
              sub: m.label == null ? null : m.name,
              price: money(m.priceMinor),
              image: m.imageUrl ?? item.imageUrl,
              selected: i == _size,
              onTap: () => _chooseSize(i),
            ),
        ],
      ),
      _Kind.question => _Cards(
        title: step.group!.name,
        rule: _rule(step.group!, s),
        needed: step.group!.min > 0 && !_answered(step.group!),
        cards: [
          for (final o in step.group!.options)
            _CardData(
              key: 'option-${o.pluId}',
              title: o.name,
              price: o.priceMinor > 0 ? '+${money(o.priceMinor)}' : s('included'),
              image: o.imageUrl,
              selected: _picks[step.group!.id]?.contains(o.pluId) ?? false,
              onTap: () => _toggle(step.group!, o),
            ),
        ],
      ),
      _Kind.review => _Review(
        item: item,
        meal: _meal,
        options: _options,
        s: s,
        onChange: (i) => _go(i),
        steps: steps,
        picks: _picks,
      ),
    };

    final back = OutlinedButton(
      onPressed: at == 0 ? widget.onBack : () => _go(at - 1),
      child: Text(s('back')),
    );
    final narrow = MediaQuery.sizeOf(context).width < 700;
    final stepper = QtyStepper(qty: _qty, min: 1, max: 20, onChanged: (q) => setState(() => _qty = q));
    final add = FilledButton(
      key: const ValueKey('add-meal'),
      onPressed: () => widget.onDone(
        BasketLine(item: item, meal: _meal, addOns: _options, qty: _qty),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Flexible(child: Text(s('add_meal'), overflow: TextOverflow.ellipsis)),
          const SizedBox(width: 12),
          Text(money(_unit * _qty)),
        ],
      ),
    );
    final Widget footer = step.kind == _Kind.review
        // On a narrow screen the button gets a row of its own: beside Back and
        // the stepper at 540 wide it was squeezed to "Add ...".
        ? narrow
            ? Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Row(children: [back, const Spacer(), stepper]),
                const SizedBox(height: 12),
                add,
              ])
            : Row(children: [
                back,
                const SizedBox(width: 14),
                stepper,
                const SizedBox(width: 14),
                Expanded(child: add),
              ])
        : Row(children: [
            back,
            const Spacer(),
            Text(money(_unit), style: text.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(width: 18),
            FilledButton(
              onPressed: step.kind == _Kind.question && !_answered(step.group!) ? null : () => _go(at + 1),
              child: Text(step.kind == _Kind.question && step.group!.min == 0 && (_picks[step.group!.id]?.isEmpty ?? true)
                  ? s('skip')
                  : s('next')),
            ),
          ]);

    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: skin.card,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(32)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(28, 20, 14, 8),
            child: Row(children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(_meal.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: text.headlineMedium),
                    Text('${s('step')} ${at + 1} ${s('of')} ${steps.length}',
                        style: TextStyle(color: skin.muted, fontWeight: FontWeight.w700, fontSize: 16)),
                  ],
                ),
              ),
              Material(
                color: skin.chip,
                shape: const CircleBorder(),
                child: IconButton(
                  iconSize: 32,
                  tooltip: s('back'),
                  icon: Icon(Icons.close_rounded, color: skin.ink),
                  onPressed: () => Navigator.of(context).pop(),
                ),
              ),
            ]),
          ),
          _Rail(
            labels: [
              for (final st in steps)
                switch (st.kind) {
                  _Kind.size => s('size'),
                  _Kind.question => st.group!.name,
                  _Kind.review => s('review'),
                },
            ],
            at: at,
            done: [for (final st in steps) _done(st)],
            onTap: (i) {
              // Only back, or to a step already reached: skipping ahead past a
              // question nobody has answered is how a meal loses its drink.
              if (i <= at || steps.take(i).every(_done)) _go(i);
            },
          ),
          Flexible(
            child: AnimatedSwitcher(
              duration: const Duration(milliseconds: 220),
              child: KeyedSubtree(key: ValueKey('step-$at-$_size'), child: body),
            ),
          ),
          Container(
            padding: const EdgeInsets.fromLTRB(24, 14, 24, 20),
            decoration: BoxDecoration(border: Border(top: BorderSide(color: skin.line))),
            child: footer,
          ),
        ],
      ),
    );
  }

  static String _rule(AddOnGroup g, S s) {
    if (g.single) return s('choose_one');
    return '${s('choose_up_to')} ${g.max}';
  }
}

/// Where the customer is: the steps across the top, ticked as they are done.
///
/// It scrolls on a narrow screen, and keeps the current step in view: at 540
/// wide the Review chip was off the right-hand edge on the Review step itself.
class _Rail extends StatefulWidget {
  const _Rail({required this.labels, required this.at, required this.done, required this.onTap});

  final List<String> labels;
  final int at;
  final List<bool> done;
  final ValueChanged<int> onTap;

  @override
  State<_Rail> createState() => _RailState();
}

class _RailState extends State<_Rail> {
  final _keys = <int, GlobalKey>{};

  GlobalKey _key(int i) => _keys.putIfAbsent(i, GlobalKey.new);

  void _reveal() {
    final chip = _keys[widget.at]?.currentContext;
    if (chip != null && chip.mounted) {
      Scrollable.ensureVisible(chip, duration: const Duration(milliseconds: 200), alignment: .5);
    }
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _reveal());
  }

  @override
  void didUpdateWidget(covariant _Rail old) {
    super.didUpdateWidget(old);
    if (old.at != widget.at) WidgetsBinding.instance.addPostFrameCallback((_) => _reveal());
  }

  @override
  Widget build(BuildContext context) {
    final skin = XpSkin.of(context);
    final labels = widget.labels;
    final at = widget.at;
    final done = widget.done;
    final onTap = widget.onTap;
    return SizedBox(
      height: 64,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
        itemCount: labels.length,
        separatorBuilder: (_, _) => Center(
          child: Container(width: 22, height: 2, margin: const EdgeInsets.symmetric(horizontal: 6), color: skin.line),
        ),
        itemBuilder: (context, i) {
          final here = i == at;
          final ticked = done[i] && !here;
          return Material(
            key: _key(i),
            color: here ? Xp.ink : (ticked ? Xp.lime : skin.chip),
            borderRadius: BorderRadius.circular(999),
            child: InkWell(
              borderRadius: BorderRadius.circular(999),
              onTap: () => onTap(i),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 14),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  if (ticked)
                    const Icon(Icons.check_rounded, size: 20, color: Xp.ink)
                  else
                    Text('${i + 1}',
                        style: TextStyle(
                            fontWeight: FontWeight.w800, fontSize: 15, color: here ? Xp.lime : skin.inkSoft)),
                  const SizedBox(width: 8),
                  Text(labels[i],
                      style: TextStyle(
                          fontWeight: FontWeight.w700,
                          fontSize: 15,
                          color: here ? Colors.white : (ticked ? Xp.ink : skin.inkSoft))),
                ]),
              ),
            ),
          );
        },
      ),
    );
  }
}

@immutable
class _CardData {
  const _CardData({
    required this.key,
    required this.title,
    required this.price,
    required this.selected,
    required this.onTap,
    this.sub,
    this.image,
  });

  final String key;
  final String title;
  final String? sub;
  final String price;
  final String? image;
  final bool selected;
  final VoidCallback onTap;
}

/// One question: a heading, its rule, and a grid of picture cards.
class _Cards extends StatelessWidget {
  const _Cards({required this.title, required this.rule, required this.cards, this.needed = false});

  final String title;
  final String? rule;
  final bool needed;
  final List<_CardData> cards;

  @override
  Widget build(BuildContext context) {
    final skin = XpSkin.of(context);
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(24, 10, 24, 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(children: [
            Expanded(child: Text(title, style: Theme.of(context).textTheme.headlineLarge)),
            if (rule != null)
              Pill(rule!, color: needed ? Xp.amber : skin.chip),
          ]),
          const SizedBox(height: 16),
          LayoutBuilder(builder: (context, box) {
            final across = (box.maxWidth / 230).floor().clamp(2, 5);
            final width = (box.maxWidth - (across - 1) * 14) / across;
            return Wrap(
              spacing: 14,
              runSpacing: 14,
              children: [
                for (final c in cards) SizedBox(width: width, child: _PictureCard(data: c)),
              ],
            );
          }),
        ],
      ),
    );
  }
}

class _PictureCard extends StatelessWidget {
  const _PictureCard({required this.data});
  final _CardData data;

  @override
  Widget build(BuildContext context) {
    final skin = XpSkin.of(context);
    final on = data.selected;
    return Material(
      key: ValueKey(data.key),
      color: skin.card,
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Xp.radius),
        side: BorderSide(color: on ? Xp.lime : skin.line, width: on ? 4 : 2),
      ),
      child: InkWell(
        onTap: data.onTap,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            AspectRatio(
              aspectRatio: 4 / 3,
              child: Stack(fit: StackFit.expand, children: [
                NetImage(data.image, icon: Icons.lunch_dining_rounded),
                if (on)
                  Positioned(
                    right: 10,
                    top: 10,
                    child: Container(
                      width: 42,
                      height: 42,
                      decoration: const BoxDecoration(color: Xp.lime, shape: BoxShape.circle),
                      child: const Icon(Icons.check_rounded, size: 30, color: Xp.ink),
                    ),
                  ),
              ]),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 10, 14, 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(data.title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: skin.ink, height: 1.15)),
                  if (data.sub != null) ...[
                    const SizedBox(height: 2),
                    Text(data.sub!,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: skin.muted)),
                  ],
                  const SizedBox(height: 6),
                  Text(data.price,
                      style: TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w800,
                          color: data.price.startsWith('+') || data.price.startsWith('£') ? skin.ink : Xp.limeDeep)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The meal as it will arrive, with a way back to change any of it.
class _Review extends StatelessWidget {
  const _Review({
    required this.item,
    required this.meal,
    required this.options,
    required this.s,
    required this.onChange,
    required this.steps,
    required this.picks,
  });

  final MenuItem item;
  final Meal meal;
  final List<AddOnOption> options;
  final S s;
  final ValueChanged<int> onChange;
  final List<_Step> steps;
  final Map<int, List<int>> picks;

  @override
  Widget build(BuildContext context) {
    final skin = XpSkin.of(context);
    final text = Theme.of(context).textTheme;
    final allergens = {...item.allergens, ...meal.allergens, for (final o in options) ...o.allergens}.toList();

    final labelWidth = MediaQuery.sizeOf(context).width < 700 ? 132.0 : 210.0;
    Widget row(String label, String value, int stepIndex) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(children: [
        SizedBox(
          width: labelWidth,
          child: Text(label, style: TextStyle(color: skin.muted, fontWeight: FontWeight.w700, fontSize: 16)),
        ),
        Expanded(child: Text(value, style: text.titleLarge)),
        TextButton(onPressed: () => onChange(stepIndex), child: Text(s('change'))),
      ]),
    );

    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(24, 10, 24, 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(Xp.radius),
                child: SizedBox(width: 150, height: 112, child: NetImage(meal.imageUrl ?? item.imageUrl)),
              ),
              const SizedBox(width: 18),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(s('your_meal'), style: TextStyle(color: skin.muted, fontWeight: FontWeight.w700, fontSize: 16)),
                    Text(meal.name, style: text.headlineMedium),
                    if (meal.label != null)
                      Text(meal.label!, style: text.titleMedium?.copyWith(color: skin.inkSoft)),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          for (final (i, st) in steps.indexed)
            if (st.kind == _Kind.size)
              row(s('size'), meal.label ?? meal.name, i)
            else if (st.kind == _Kind.question)
              row(
                st.group!.name,
                [
                  for (final plu in picks[st.group!.id] ?? const <int>[])
                    ?st.group!.options.where((o) => o.pluId == plu).firstOrNull?.name,
                ].join(', ').orDash,
                i,
              ),
          const SizedBox(height: 14),
          AllergenBlock(codes: allergens, declared: item.allergensDeclared, s: s),
        ],
      ),
    );
  }
}

extension on String {
  /// A step with no answer -- a question that could be skipped -- reads "-".
  String get orDash => isEmpty ? '-' : this;
}
