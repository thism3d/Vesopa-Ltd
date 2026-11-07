/// How the venue splits bills, set in the back office (Vesopa Go options,
/// "Splitting a bill", which the till reads too; owner, 2026-11-07: "proper
/// settings in back office"). One JSON document per venue on the server, so a
/// new option needs no change to the database.
library;

import 'dart:convert';

import 'package:http/http.dart' as http;

class SplitOptions {
  const SplitOptions({
    this.defaultMethod = 'items',
    this.nextPrompt = true,
    this.printAll = true,
    this.names = true,
    this.byAmount = true,
  });

  /// What the split screen opens on: items | equally | amount.
  final String defaultMethod;

  /// After a share is paid, ask "Pay the next share?" (Newbridge does).
  final bool nextPrompt;

  /// A Print All key for every share's bill at once.
  final bool printAll;

  /// Shares can be given a person's name.
  final bool names;

  /// Split by amount is offered.
  final bool byAmount;

  static SplitOptions fromGo(Map<String, dynamic> go) {
    bool flag(String k, bool def) => go[k] is bool ? go[k] as bool : def;
    final m = '${go['split_default'] ?? 'items'}';
    return SplitOptions(
      defaultMethod: const {'items', 'equally', 'amount'}.contains(m) ? m : 'items',
      nextPrompt: flag('split_next_prompt', true),
      printAll: flag('split_print_all', true),
      names: flag('split_names', true),
      byAmount: flag('split_by_amount', true),
    );
  }

  /// The venue's options, or the defaults when the back office cannot be asked:
  /// a split must never wait on the internet.
  static Future<SplitOptions> fetch(String apiBase, String? token, {http.Client? client}) async {
    if ((token ?? '').isEmpty) return const SplitOptions();
    try {
      final res = await (client ?? http.Client())
          .get(Uri.parse('$apiBase/api/tap/config'), headers: {'Authorization': 'Bearer $token'})
          .timeout(const Duration(seconds: 4));
      if (res.statusCode != 200) return const SplitOptions();
      final body = jsonDecode(res.body);
      final go = body is Map && body['go'] is Map ? Map<String, dynamic>.from(body['go'] as Map) : const <String, dynamic>{};
      return fromGo(go);
    } catch (_) {
      return const SplitOptions();
    }
  }
}
