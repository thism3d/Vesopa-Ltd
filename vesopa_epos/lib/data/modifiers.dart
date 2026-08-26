/// Modifiers: the question a product asks before it goes on the bill.
///
/// "Which mixer with that gin?", "how would you like the steak?". A product
/// carries an ordered list of groups, each group is one prompt, and the answers
/// hang off the sale line underneath the product they belong to.
///
/// ---------------------------------------------------------------------------
/// Why there are no buttons in here
/// ---------------------------------------------------------------------------
/// A group's answers are a grid of buttons, and a grid of buttons is a screen.
/// So a group holds a `screenId` and nothing more: the layout arrives with
/// every other screen in the same `/till/screens` fetch, caches in the same
/// blob, and draws with the same button code. See `data/screens.dart` and
/// vesopa_server/schema_screens_modifiers.sql.
///
/// That is also why this file is small. It is the wiring — which questions
/// exist, how they behave, which product asks which — and nothing else.
library;

import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../main.dart';


/// One question, and the two numbers that are its whole behaviour.
class ModifierGroup {
  const ModifierGroup({
    required this.id,
    required this.name,
    this.minSelect = 0,
    this.maxSelect = 1,
    this.screenId,
  });

  factory ModifierGroup.fromJson(Map<String, dynamic> j) => ModifierGroup(
    id: (j['id'] as num).toInt(),
    name: (j['name'] as String?) ?? '',
    minSelect: (j['min_select'] as num?)?.toInt() ?? 0,
    maxSelect: (j['max_select'] as num?)?.toInt() ?? 1,
    screenId: (j['screen_id'] as num?)?.toInt(),
  );

  final int id;
  final String name;

  /// How few answers this question will accept.
  ///
  /// 0 means the prompt can be dismissed, and the till offers Skip. Above 0 it
  /// cannot: Skip is not offered and Done stays disabled until enough is
  /// chosen. That is the whole of "is this modifier compulsory".
  final int minSelect;

  /// How many answers it will take. 1 is the common case and the reason a mixer
  /// costs one press — the prompt closes on the tap and the next question
  /// opens. 0 means no ceiling.
  final int maxSelect;

  /// The screen holding the answers, or null for a group nobody has laid out.
  ///
  /// A null here — or a screen that has gone — is not an error. The till skips
  /// the question rather than opening an empty box in front of a queue.
  final int? screenId;

  /// Whether the operator may dismiss this question without answering it.
  bool get skippable => minSelect <= 0;

  /// Whether choosing one answer is itself the confirmation.
  bool get closesOnFirstPick => maxSelect == 1;

  bool get unlimited => maxSelect <= 0;

  /// Whether [count] answers is enough to move on.
  bool satisfiedBy(int count) => count >= minSelect;

  /// Whether another answer may still be taken.
  bool canTakeMore(int count) => unlimited || count < maxSelect;

  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'min_select': minSelect,
    'max_select': maxSelect,
    if (screenId != null) 'screen_id': screenId,
  };
}

/// Every question in the venue, and which product asks which.
class ModifierSet {
  const ModifierSet({this.groups = const [], this.byPlu = const {}});

  factory ModifierSet.fromJson(Map<String, dynamic> j) {
    final groups = [
      for (final g in (j['groups'] as List? ?? const []))
        ModifierGroup.fromJson(g as Map<String, dynamic>),
    ];
    final byPlu = <int, List<int>>{};
    final raw = j['products'];
    if (raw is Map) {
      raw.forEach((key, value) {
        final plu = int.tryParse('$key');
        if (plu == null || value is! List) return;
        byPlu[plu] = [
          for (final id in value)
            if (id is num) id.toInt(),
        ];
      });
    }
    return ModifierSet(groups: groups, byPlu: byPlu);
  }

  static const empty = ModifierSet();

  final List<ModifierGroup> groups;

  /// PLU to the group ids it asks, in the order they are asked.
  final Map<int, List<int>> byPlu;

  ModifierGroup? byId(int id) {
    for (final g in groups) {
      if (g.id == id) return g;
    }
    return null;
  }

  /// The questions this product asks, in order.
  ///
  /// Groups the venue has since deleted drop out rather than appearing as a
  /// blank prompt: the wiring row is gone by cascade, but a cached feed on a
  /// till that has been offline can still name one.
  List<ModifierGroup> forPlu(int pluId) {
    final ids = byPlu[pluId];
    if (ids == null || ids.isEmpty) return const [];
    final found = <ModifierGroup>[];
    for (final id in ids) {
      final group = byId(id);
      if (group != null) found.add(group);
    }
    return found;
  }

  bool get isEmpty => groups.isEmpty || byPlu.isEmpty;

  Map<String, dynamic> toJson() => {
    'groups': [for (final g in groups) g.toJson()],
    'products': {
      for (final entry in byPlu.entries) '${entry.key}': entry.value,
    },
  };
}

/// Fetches the venue's modifiers, and keeps the last good copy.
///
/// Cached in exactly the way screens are, and for the same reason: a till whose
/// server is mid-deploy, or whose venue has lost its line, must carry on taking
/// orders. A gin that stops asking about mixers because the network is down is
/// a wrong ticket in the kitchen, not a graceful degradation — so the last
/// known wiring is used rather than none.
class ModifiersRepository {
  ModifiersRepository({required this.apiBase, http.Client? client})
    : _client = client ?? http.Client();

  final String apiBase;
  final http.Client _client;

  static const _key = 'vesopa_till_modifiers';

  Future<ModifierSet> load(String office) async {
    try {
      final res = await _client
          .get(Uri.parse('$apiBase/api/till/modifiers?office=$office'))
          .timeout(const Duration(seconds: 8));
      if (res.statusCode != 200) return _cached();

      final set = ModifierSet.fromJson(
        jsonDecode(res.body) as Map<String, dynamic>,
      );
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_key, jsonEncode(set.toJson()));
      return set;
    } catch (_) {
      return _cached();
    }
  }

  Future<ModifierSet> _cached() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_key);
      if (raw == null || raw.isEmpty) return ModifierSet.empty;
      return ModifierSet.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      // A cache written by a different release, or half-written. An empty set
      // means products stop asking — which is wrong, but it is the same
      // behaviour as before modifiers existed, and it still sells.
      return ModifierSet.empty;
    }
  }
}

final modifiersRepositoryProvider = Provider<ModifiersRepository>(
  (ref) => ModifiersRepository(apiBase: ref.watch(apiBaseProvider)),
);

/// The venue's modifiers, refreshed when the back office says they moved.
///
/// The push half matters as much as it does for screens: without it these are
/// fetched once at sign-on, and a manager who attaches a mixer question to a
/// gin would watch the back office confirm the save and find every till in the
/// building still not asking until somebody restarted the app.
final modifiersProvider = FutureProvider<ModifierSet>((ref) async {
  ref.listen(syncEventsProvider, (_, next) {
    if (next.value?.type == 'modifiers') ref.invalidateSelf();
  });

  final office = ref.watch(officeProvider);
  if (office.isEmpty) return ModifierSet.empty;
  return ref.watch(modifiersRepositoryProvider).load(office);
});
