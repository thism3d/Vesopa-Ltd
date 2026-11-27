/// Voice commands for the TV remote (owner, 2026-11-27: "talk to remote and
/// do jobs like expand the last order and mark as done ... in the customer
/// display change the adverts and keep the current advert for minutes").
///
/// The phone listens (speech_to_text, on the device), and [VoiceCommands.parse]
/// turns what was said into the remote's keys for the screen being
/// controlled. Plain words, a few ways of saying each; one sentence can hold
/// two commands joined by "and" or "then" ("show the last order and mark it
/// done"). [VoiceCommands.help] lists them for the remote's help sheet.
library;

class VoiceStep {
  const VoiceStep(this.key, {this.text, this.index});
  final String key;
  final String? text;
  final int? index;

  @override
  String toString() => text == null ? key : '$key "$text"';
}

class VoiceResult {
  const VoiceResult(this.steps, this.said);
  final List<VoiceStep> steps;

  /// What was understood, in words, for the phone to show.
  final String said;
  bool get understood => steps.isNotEmpty;
}

class VoiceCommands {
  VoiceCommands._();

  static const _numbers = {
    'one': 1, 'a': 1, 'an': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8,
    'nine': 9, 'ten': 10, 'fifteen': 15, 'twenty': 20, 'thirty': 30, 'forty': 40, 'forty-five': 45, 'sixty': 60,
    'half': 30,
  };

  static const _colours = {
    'lime': 'lime', 'green': 'lime', 'vesopa': 'lime', 'volt': 'volt', 'yellow': 'volt', 'neon': 'neon',
    'mint': 'mint', 'aqua': 'aqua', 'blue': 'aqua', 'cyan': 'aqua', 'pink': 'pink', 'hot pink': 'pink',
    'pearl': 'pearl', 'white': 'pearl',
  };

  static int? _number(String s) {
    final m = RegExp(r'(\d+|[a-z-]+)\s+(minute|minutes|min|mins|second|seconds|secs|hour|hours)').firstMatch(s);
    if (m == null) return null;
    final n = int.tryParse(m.group(1)!) ?? _numbers[m.group(1)!];
    if (n == null) return null;
    final unit = m.group(2)!;
    if (unit.startsWith('hour')) return n * 60;
    return n;
  }

  /// [mode] is what the screen runs as: kitchen or display.
  static VoiceResult parse(String heard, {required String mode}) {
    final all = heard.toLowerCase().replaceAll(RegExp(r"[^a-z0-9'\- ]"), ' ').replaceAll(RegExp(r'\s+'), ' ').trim();
    final steps = <VoiceStep>[];
    final words = <String>[];
    for (final part in all.split(RegExp(r'\b(?:and then|then|and also|and)\b'))) {
      final s = part.trim();
      if (s.isEmpty) continue;
      final got = _one(s, mode: mode);
      if (got != null) {
        steps.addAll(got.$1);
        words.add(got.$2);
      }
    }
    return VoiceResult(steps, words.join(', then '));
  }

  static (List<VoiceStep>, String)? _one(String s, {required String mode}) {
    bool has(String pattern) => RegExp(pattern).hasMatch(s);
    final kitchen = mode == 'kitchen';

    // Typing: "type pass two" puts the words in the box the screen is on.
    final type = RegExp(r'^(?:type|write|enter)\s+(.+)$').firstMatch(s);
    if (type != null) return ([VoiceStep('text', text: type.group(1)!.trim()), const VoiceStep('submit')], 'type "${type.group(1)!.trim()}"');

    // What the screen is.
    if (has(r'switch (?:to |it to )?(?:the )?kitchen|make (?:it|this) (?:a |the )?kitchen|kitchen (?:screen|mode)')) {
      return ([const VoiceStep('mode:kitchen')], 'switch to Kitchen screen');
    }
    if (has(r'switch (?:to |it to )?(?:the )?(?:customer )?display|make (?:it|this) (?:a |the )?(?:customer )?display|display mode')) {
      return ([const VoiceStep('mode:display')], 'switch to Customer display');
    }

    // The TV itself.
    if (has(r'\bunmute\b|sound on')) return ([const VoiceStep('mute')], 'sound back on');
    if (has(r'\bmute\b|sound off|silence')) return ([const VoiceStep('mute')], 'mute');
    if (has(r'volume up|louder|turn (?:it )?up')) return ([const VoiceStep('volume_up'), const VoiceStep('volume_up')], 'volume up');
    if (has(r'volume down|quieter|turn (?:it )?down|softer')) return ([const VoiceStep('volume_down'), const VoiceStep('volume_down')], 'volume down');
    if (has(r'(?:screen|tv|display) off|turn off|switch off|sleep|go dark')) return ([const VoiceStep('power')], 'screen off');
    if (has(r'(?:screen|tv|display) on|turn on|switch on|wake(?: up)?')) return ([const VoiceStep('ok')], 'screen on');
    if (has(r'dark mode|night mode|\bnight\b')) return ([const VoiceStep('appearance:dark')], 'Night look');
    if (has(r'light mode|day mode|\bday\b')) return ([const VoiceStep('appearance:light')], 'Day look');
    final colour = RegExp(r'(?:colou?r|theme)\s+(?:to\s+)?([a-z ]+)').firstMatch(s);
    if (colour != null) {
      final name = colour.group(1)!.trim();
      final id = _colours[name] ?? _colours[name.split(' ').last];
      if (id != null) return ([VoiceStep('theme:$id')], '$id colour');
    }

    // Kitchen.
    if (kitchen) {
      if (has(r'(?:show|open|expand|see|read)\b.*\b(?:last|latest|newest|new) (?:order|ticket)')) {
        return ([const VoiceStep('expand_last')], 'show the newest order');
      }
      if (has(r'(?:show|open|expand|see|read)\b.*\b(?:first|oldest|next) (?:order|ticket)')) {
        return ([const VoiceStep('expand_first')], 'show the oldest order');
      }
      if (has(r'\b(?:mark|set)\b.*\b(?:done|ready|complete|finished)|\bbump\b|\bit.?s ready\b|\border (?:is )?(?:done|ready)\b|^(?:done|ready|complete)$')) {
        return ([const VoiceStep('done_shown')], 'mark it done');
      }
      if (has(r'\brecall\b|bring (?:it |that )?back|undo')) return ([const VoiceStep('recall')], 'recall the last done');
      if (has(r'(?:show|open|go to) (?:the )?(?:done|closed|finished|completed)')) return ([const VoiceStep('finished')], 'show Closed');
      if (has(r'(?:show|open|go to) (?:the )?(?:phone|online) orders|^orders$')) return ([const VoiceStep('orders')], 'show phone orders');
      if (has(r'(?:show|open|go to) (?:the )?(?:open|tickets|board|kitchen)')) return ([const VoiceStep('tickets')], 'show Open');
      if (has(r'(?:choose|change|pick) (?:the )?(?:board|station)')) return ([const VoiceStep('board')], 'choose the board');
      if (has(r'pop.?up|new orders? (?:for|show)')) {
        if (has(r'\boff\b|\bno\b|\bnever\b')) return ([const VoiceStep('popup:0')], 'new-order pop-up off');
        final n = _number(s) ?? 10;
        return ([VoiceStep('popup:$n')], 'new orders fill the screen for $n s');
      }
    } else {
      // Customer display.
      if (has(r'\b(?:keep|hold|stay|pause|freeze)\b')) {
        final n = _number(s) ?? 5;
        return ([VoiceStep('hold:$n')], 'keep this advert for $n min');
      }
      if (has(r'\b(?:resume|play|carry on|continue|start)\b.*\badverts?\b|\badverts? (?:on|again)')) return ([const VoiceStep('hold:0')], 'adverts run again');
      if (has(r'\bnext\b|\bchange\b.*\badvert|skip')) return ([const VoiceStep('next')], 'next advert');
      if (has(r'previous|\blast advert\b|go back an advert')) return ([const VoiceStep('previous')], 'previous advert');
      if (has(r'reload|refresh')) return ([const VoiceStep('refresh')], 'reload the adverts');
    }

    // Anywhere.
    if (has(r'^(?:go )?home$|go home|main screen|close (?:everything|all)')) return ([const VoiceStep('home')], 'home');
    if (has(r'settings')) return ([const VoiceStep('settings')], 'settings');
    if (has(r'refresh|reload')) return ([const VoiceStep('refresh')], 'refresh');
    if (has(r'^(?:go )?back$|go back|close')) return ([const VoiceStep('back')], 'back');
    for (final d in const ['up', 'down', 'left', 'right']) {
      if (has('^(?:go |move )?$d\$')) return ([VoiceStep(d)], d);
    }
    if (has(r'^(?:ok|okay|select|press|enter|open)$')) return ([const VoiceStep('ok')], 'OK');
    return null;
  }

  /// The commands, for the remote's help sheet.
  static const help = <(String, List<String>)>[
    ('Kitchen screen', [
      '"Show the last order": the newest ticket, full screen',
      '"Show the oldest order"',
      '"Mark it done" / "Bump" / "It\'s ready": the shown ticket (or the front one) is done',
      '"Recall": the last done ticket comes back',
      '"Show open" / "Show closed" / "Show phone orders"',
      '"Choose the board"',
      '"Pop up new orders for 15 seconds" / "Pop up off"',
    ]),
    ('Customer display', [
      '"Next advert" / "Previous advert"',
      '"Keep this advert for 5 minutes" (seconds, minutes or hours)',
      '"Resume adverts"',
      '"Reload adverts"',
    ]),
    ('Any screen', [
      '"Switch to kitchen" / "Switch to customer display"',
      '"Volume up" / "Volume down" / "Mute"',
      '"Screen off" / "Wake up"',
      '"Colour pink" (lime, volt, neon, mint, aqua, pink, pearl)',
      '"Dark mode" / "Light mode"',
      '"Settings", "Home", "Back", "Up", "Down", "Left", "Right", "OK"',
      '"Type Pass two": types into the box the screen is on',
      'Two at once: "Show the last order and mark it done"',
    ]),
  ];
}
