import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';

import '../../data/screen_profile.dart';
import '../../data/ticket.dart';
import '../theme.dart';

/// One order on the board.
///
/// The layout is the reference recording's, because it is the layout every
/// kitchen screen on the market uses and a chef who has worked anywhere else
/// already knows how to read it:
///
/// ```
///   Table #4                     Order 60292:4      header, coloured by age
///   Lounge                              sophie
///   19:38                        Elapsed: 06:52
///   ─────────────────────────────────────────────
///    1  Crispy Chicken Burger                      body, modifiers in red
///       no tomato, no garlic
///    1  Kids Breakfast
///   ─────────────────────────────────────────────
///          Details                ✓  Done          footer
/// ```
///
/// What we add to it is the ageing (see [TicketAge]) and the station chips,
/// both of which the reference leaves out and both of which a kitchen with more
/// than one screen cannot work without.
class TicketCard extends StatefulWidget {
  const TicketCard({
    super.key,
    required this.ticket,
    required this.profile,
    required this.now,
    required this.labelFor,
    this.onBump,
    this.onRecall,
    this.onDetails,
    this.onRush,
    this.onLineMade,
  });

  final Ticket ticket;
  final ScreenProfile profile;

  /// The corrected clock — see `BoardState.now`. Passed in rather than read
  /// here so every card on the board ages against exactly the same instant, and
  /// two cards a second apart cannot disagree about which is older.
  final DateTime now;

  /// What the venue calls a station.
  final String Function(String station) labelFor;

  final VoidCallback? onBump;
  final VoidCallback? onRecall;
  final VoidCallback? onDetails;
  final ValueChanged<bool>? onRush;

  /// Cross one item off, or put it back. Null on the Completed tab, where the
  /// work is already done and the only useful action is recall.
  final void Function(TicketLine line, bool made)? onLineMade;

  @override
  State<TicketCard> createState() => _TicketCardState();
}

class _TicketCardState extends State<TicketCard>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  );

  static final _clock = DateFormat('HH:mm');

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _syncPulse();
  }

  @override
  void didUpdateWidget(covariant TicketCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncPulse();
  }

  /// A late ticket breathes, once a second.
  ///
  /// Motion rather than a brighter red, because the board is read from across
  /// a room and out of the corner of an eye. A colour has to be looked at to be
  /// noticed; movement catches the eye that was looking somewhere else, which is
  /// the entire job of the late state.
  void _syncPulse() {
    final shouldPulse =
        _isOpen && TicketAge.of(_age, widget.profile) == TicketAge.late;
    if (shouldPulse && !_pulse.isAnimating) {
      _pulse.repeat(reverse: true);
    } else if (!shouldPulse && _pulse.isAnimating) {
      _pulse.stop();
      _pulse.value = 0;
    }
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  bool get _isOpen => widget.ticket.isOpenFor(widget.profile.stations);
  Duration get _age => widget.ticket.age(widget.now);

  /// The header colour, which is the whole of what this card says at a glance.
  Color get _headline {
    if (!_isOpen) return Kds.done;
    if (widget.ticket.rushed) return Kds.rush;
    return switch (TicketAge.of(_age, widget.profile)) {
      TicketAge.fresh => Kds.fresh,
      TicketAge.warn => Kds.warn,
      TicketAge.late => Kds.late,
    };
  }

  /// `06:52`, and `1:04:11` once a ticket has been waiting over an hour.
  ///
  /// The hour is only shown when there is one, because a board where every
  /// clock reads `00:06:52` has spent three characters of a chef's attention on
  /// a zero.
  String get _elapsed {
    final age = _age.isNegative ? Duration.zero : _age;
    final h = age.inHours;
    final m = age.inMinutes.remainder(60).toString().padLeft(2, '0');
    final s = age.inSeconds.remainder(60).toString().padLeft(2, '0');
    return h > 0 ? '$h:$m:$s' : '$m:$s';
  }

  @override
  Widget build(BuildContext context) {
    final ticket = widget.ticket;
    final lines = ticket.linesFor(widget.profile.stations);
    final ink = Kds.inkOn(_headline);
    final mutedInk = Kds.mutedInkOn(_headline);

    return AnimatedBuilder(
      animation: _pulse,
      builder: (context, child) => Container(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(10),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.06 + _pulse.value * 0.10),
              blurRadius: 6 + _pulse.value * 10,
              offset: const Offset(0, 2),
            ),
          ],
        ),
        child: child,
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            // ---- Header ----------------------------------------------------
            GestureDetector(
              // A long press on the header rushes it. Deliberately not a
              // button: rush is a judgement made a handful of times a service,
              // and a permanent key for it would sit on every card taking up
              // room that the food needs.
              onLongPress: widget.onRush == null
                  ? null
                  : () => widget.onRush!(!ticket.rushed),
              child: Container(
                color: _headline,
                padding: const EdgeInsets.fromLTRB(12, 9, 12, 9),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _HeaderRow(
                      left: ticket.destination,
                      right: ticket.ticketNo == null
                          ? ''
                          : 'Order ${ticket.ticketNo}',
                      color: ink,
                      bold: true,
                      size: 19,
                    ),
                    const SizedBox(height: 2),
                    _HeaderRow(
                      left: ticket.roomName ?? ticket.kind.label,
                      right: ticket.staffName ?? '',
                      color: mutedInk,
                      size: 14,
                    ),
                    const SizedBox(height: 1),
                    _HeaderRow(
                      left: _clock.format(ticket.placedAt),
                      right: _isOpen
                          ? 'Elapsed: $_elapsed'
                          : 'Done ${_doneAt(ticket)}',
                      color: mutedInk,
                      size: 14,
                    ),

                    if (ticket.rushed || ticket.covers != null) ...[
                      const SizedBox(height: 6),
                      Row(
                        children: [
                          if (ticket.rushed)
                            _Pill(
                              icon: Icons.bolt,
                              label: 'RUSH',
                              color: ink,
                            ),
                          if (ticket.covers != null)
                            _Pill(
                              icon: Icons.people_outline,
                              label: '${ticket.covers} covers',
                              color: mutedInk,
                            ),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
            ),

            // ---- Body ------------------------------------------------------
            Container(
              color: Kds.card,
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final line in lines)
                    _LineRow(
                      line: line,
                      // Only when this board watches more than one station.
                      // On a single-station screen every chip would say the
                      // same thing, which is noise on the one surface that
                      // cannot afford any.
                      station: _stationChipFor(line),
                      onMade: widget.onLineMade == null
                          ? null
                          : () => widget.onLineMade!(line, !line.made),
                    ),

                  if (ticket.note != null) ...[
                    const Divider(height: 12, indent: 12, endIndent: 12),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(12, 0, 12, 2),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Icon(
                            Icons.sticky_note_2_outlined,
                            size: 17,
                            color: Kds.modifier,
                          ),
                          const SizedBox(width: 6),
                          Expanded(
                            child: Text(
                              ticket.note!,
                              style: const TextStyle(
                                color: Kds.modifier,
                                fontSize: 16,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],

                  // Somebody else's half of this order is still cooking. Only
                  // ever visible on a kitchen with more than one screen; on a
                  // single-screen board every station is this board's, so this
                  // can never fire.
                  if (ticket.isPartlyDone && _isOpen)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(12, 6, 12, 0),
                      child: Text(
                        'Still with ${ticket.outstanding.map(widget.labelFor).join(', ')}',
                        style: const TextStyle(
                          fontSize: 13,
                          color: Kds.inkMuted,
                          fontStyle: FontStyle.italic,
                        ),
                      ),
                    ),
                ],
              ),
            ),

            // ---- Footer ----------------------------------------------------
            if (_isOpen) _openFooter() else _completedFooter(),
          ],
        ),
      ),
    );
  }

  /// The station chip for a line, or null when it would say nothing.
  String? _stationChipFor(TicketLine line) {
    final watched = widget.profile.stations;
    if (watched.length < 2) return null;
    final mine = line.stations.where(watched.contains).toList();
    if (mine.length != 1) return null;
    return widget.labelFor(mine.first);
  }

  /// When *this board's* stations finished — see [Ticket.completedAtFor].
  String _doneAt(Ticket ticket) {
    final at = ticket.completedAtFor(widget.profile.stations);
    return at == null ? '' : _clock.format(at);
  }

  /// Two keys, as the reference has: the ticket in detail, and done.
  ///
  /// Done is on the right and is the wider of the two, because it is what
  /// happens to every card eventually and the left key is what happens to
  /// almost none of them. Putting the rare one under the thumb that reaches for
  /// the common one is how a board gets bumped by accident.
  Widget _openFooter() => Container(
    color: Kds.surface,
    child: Row(
      children: [
        Expanded(
          flex: 4,
          child: _FooterButton(
            icon: Icons.receipt_long_outlined,
            label: 'Details',
            onTap: widget.onDetails,
          ),
        ),
        const SizedBox(width: 1),
        Expanded(
          flex: 6,
          child: _FooterButton(
            icon: Icons.check,
            label: 'Done',
            emphasis: true,
            onTap: widget.onBump,
          ),
        ),
      ],
    ),
  );

  /// One full-width key, and the reference's wording: a completed card exists
  /// for exactly one reason, which is that somebody wants it back.
  Widget _completedFooter() => Container(
    color: Kds.surface,
    child: _FooterButton(
      icon: Icons.undo,
      label: 'Recall Order',
      onTap: widget.onRecall,
    ),
  );
}

class _HeaderRow extends StatelessWidget {
  const _HeaderRow({
    required this.left,
    required this.right,
    required this.color,
    this.size = 14,
    this.bold = false,
  });

  final String left;
  final String right;
  final Color color;
  final double size;
  final bool bold;

  @override
  Widget build(BuildContext context) {
    final style = TextStyle(
      color: color,
      fontSize: size,
      fontWeight: bold ? FontWeight.w700 : FontWeight.w500,
      height: 1.2,
    );
    return Row(
      children: [
        Expanded(child: Text(left, style: style, overflow: TextOverflow.fade)),
        if (right.isNotEmpty)
          Text(right, style: style, textAlign: TextAlign.right),
      ],
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({required this.icon, required this.label, required this.color});

  final IconData icon;
  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 15, color: color),
          const SizedBox(width: 3),
          Text(
            label,
            style: TextStyle(
              color: color,
              fontSize: 12.5,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.4,
            ),
          ),
        ],
      ),
    );
  }
}

/// One item on the card, and the thing a chef actually taps.
///
/// Tapping crosses it off: the name rules through, the row fades back, and a
/// tick appears where the eye is already going. Tapping again puts it back,
/// because the commonest reason to cross off the wrong line is a wet finger on
/// a busy pass and there has to be a way out of it that is not "recall the
/// whole ticket".
///
/// The modifier rules through with its line. A struck item whose "no bacon"
/// still reads at full strength looks like an instruction that has been missed
/// rather than one that has been followed.
class _LineRow extends StatelessWidget {
  const _LineRow({required this.line, this.station, this.onMade});

  final TicketLine line;
  final String? station;
  final VoidCallback? onMade;

  @override
  Widget build(BuildContext context) {
    final made = line.made;

    // Faded, not hidden. A crossed-off item is still part of the order — the
    // chef needs to be able to read back what has been done, and the pass needs
    // to see the whole ticket when it lands.
    final nameColour = made ? Kds.inkMuted : Kds.ink;
    final decoration = made ? TextDecoration.lineThrough : TextDecoration.none;

    final row = Padding(
      padding: const EdgeInsets.fromLTRB(12, 3, 12, 3),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // A fixed column for the quantity, so the item names line up down
              // the card. A ragged left edge costs a fraction of a second per
              // line to read, several hundred times a service.
              SizedBox(
                width: 26,
                child: Text(
                  line.quantityLabel,
                  textAlign: TextAlign.right,
                  style: TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w700,
                    color: nameColour,
                    decoration: decoration,
                    decorationColor: nameColour,
                    decorationThickness: 2,
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  line.name,
                  style: TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w600,
                    color: nameColour,
                    height: 1.25,
                    decoration: decoration,
                    decorationColor: nameColour,
                    decorationThickness: 2,
                  ),
                ),
              ),
              if (station != null)
                Container(
                  margin: const EdgeInsets.only(left: 6, top: 2),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 6,
                    vertical: 1,
                  ),
                  decoration: BoxDecoration(
                    color: Kds.surface,
                    borderRadius: BorderRadius.circular(5),
                  ),
                  child: Text(
                    station!,
                    style: const TextStyle(
                      fontSize: 11.5,
                      fontWeight: FontWeight.w700,
                      color: Kds.inkMuted,
                    ),
                  ),
                ),

              // The tick sits in a fixed slot whether or not it is showing, so
              // crossing a line off does not shuffle the text under the finger
              // that is still moving down the ticket.
              SizedBox(
                width: 26,
                child: made
                    ? const Icon(Icons.check, size: 19, color: Kds.inkMuted)
                    : null,
              ),
            ],
          ),

          // The modifier. Red, indented under its line, and the only colour in
          // the body of the card — which is what keeps it meaning "read this
          // bit" rather than becoming decoration.
          if (line.note != null)
            Padding(
              padding: const EdgeInsets.only(left: 36, top: 1),
              child: Text(
                line.note!,
                style: TextStyle(
                  fontSize: 15.5,
                  fontWeight: FontWeight.w600,
                  color: made ? Kds.modifierMuted : Kds.modifier,
                  height: 1.25,
                  decoration: decoration,
                  decorationColor: made ? Kds.modifierMuted : Kds.modifier,
                  decorationThickness: 2,
                ),
              ),
            ),
        ],
      ),
    );

    if (onMade == null) return row;

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: () {
          // Kitchens are loud and screens are greasy. A tap that gives nothing
          // back gets repeated, and the repeat un-crosses the line.
          HapticFeedback.selectionClick();
          onMade!();
        },
        // The whole row, not just the words. A chef aiming at "Chips" with the
        // side of a thumb should not have to hit the glyphs.
        child: row,
      ),
    );
  }
}

class _FooterButton extends StatelessWidget {
  const _FooterButton({
    required this.icon,
    required this.label,
    this.onTap,
    this.emphasis = false,
  });

  final IconData icon;
  final String label;
  final VoidCallback? onTap;

  /// The one the thumb is reaching for.
  final bool emphasis;

  @override
  Widget build(BuildContext context) {
    final color = emphasis ? Kds.done : Kds.inkMuted;
    return Material(
      color: emphasis ? Kds.done.withValues(alpha: 0.10) : Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: SizedBox(
          // 52 tall. The board is pressed with a finger by somebody who is not
          // looking straight at it, and this is the smallest target that
          // survives that.
          height: 52,
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(icon, size: emphasis ? 26 : 20, color: color),
              const SizedBox(width: 8),
              Text(
                label,
                style: TextStyle(
                  fontSize: emphasis ? 17 : 15,
                  fontWeight: FontWeight.w700,
                  color: color,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
