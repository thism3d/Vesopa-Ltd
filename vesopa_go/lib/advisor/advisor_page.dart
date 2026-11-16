/// Vesopa AI on Go (owner, 2026-11-16): "A business owner should be able to
/// open Vesopa Go, tap Vesopa AI and immediately understand what is happening
/// in their business."
///
/// Opens on the daily briefing. Ask is the conversation; Sales, Stock, Profit
/// and Team ask set questions side by side. On a tablet the conversation list
/// sits beside the chat. Every figure is the server's (ai_metrics.js); Go only
/// lays it out, and every answer carries its period, site, definition,
/// freshness and the records behind it.
///
/// For managers: the clerk signed in must be one (the server checks the PIN
/// and the till's is_manager), or a manager's PIN is asked for.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/api.dart';
import '../data/models.dart';
import '../data/session.dart';
import '../ui/theme.dart';
import 'advisor_api.dart';
import 'advisor_widgets.dart';

final advisorApiProvider = Provider<AdvisorApi>((ref) => AdvisorApi(ref.watch(apiProvider)));

const _suggested = [
  'How much did we make today?',
  'Why did sales drop yesterday?',
  'Which products make the most profit?',
  'What stock should I reorder?',
  'Which site performed best this week?',
  'How is my team performing?',
  'Compare this week with last week',
  'What should I focus on tomorrow?',
];

const _sections = <String, List<String>>{
  'Sales': ['Compare this week with last week', 'What were the best sellers this week?', 'What are the slowest sellers this week?'],
  'Stock': ['What stock should I reorder?'],
  'Profit': ['Which products make the most profit in the last 7 days?'],
  'Team': ['How is my team performing this week?', 'Which site performed best this week?'],
};

/// Opens Vesopa AI: straight in for a manager, a manager's PIN otherwise.
Future<void> openVesopaAi(BuildContext context, WidgetRef ref) async {
  final s = ref.read(tapProvider);
  final messenger = ScaffoldMessenger.of(context);
  if (s.demo) {
    messenger.showSnackBar(const SnackBar(content: Text('Vesopa AI reads your real sales, so it is not in the demo.')));
    return;
  }
  Clerk? manager = s.clerk != null && s.clerk!.can(TillPermission.isManager) ? s.clerk : null;
  if (manager == null) {
    final pin = await _askPin(context);
    if (pin == null) return;
    manager = ref.read(tapProvider.notifier).managerByPin(pin);
    if (manager == null) {
      messenger.showSnackBar(const SnackBar(content: Text('Vesopa AI is for managers. That is not a manager\'s PIN.')));
      return;
    }
  }
  try {
    await ref.read(advisorApiProvider).signIn(manager.id, manager.pin);
  } on TapApiError catch (e) {
    messenger.showSnackBar(SnackBar(content: Text(e.message)));
    return;
  }
  if (!context.mounted) return;
  await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const AdvisorPage()));
}

Future<String?> _askPin(BuildContext context) {
  final pin = TextEditingController();
  return showDialog<String>(
    context: context,
    builder: (c) => AlertDialog(
      title: const Row(children: [AiMark(size: 28), SizedBox(width: 10), Text('Vesopa AI')]),
      content: TextField(
        controller: pin,
        autofocus: true,
        obscureText: true,
        keyboardType: TextInputType.number,
        decoration: const InputDecoration(labelText: 'Manager\'s PIN'),
        onSubmitted: (v) => Navigator.pop(c, v.trim()),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(c, pin.text.trim()), child: const Text('Open')),
      ],
    ),
  );
}

class AdvisorPage extends ConsumerStatefulWidget {
  const AdvisorPage({super.key});
  @override
  ConsumerState<AdvisorPage> createState() => _AdvisorPageState();
}

class _AdvisorPageState extends ConsumerState<AdvisorPage> with SingleTickerProviderStateMixin {
  late final TabController _tabs = TabController(length: 6, vsync: this);
  Json? _me;
  String? _site;
  String? _error;

  // Briefing.
  Json? _brief;
  // Ask.
  int? _convo;
  final List<Json> _thread = [];
  List<Json> _convos = [];
  bool _busy = false;
  final _input = TextEditingController();
  final _scroll = ScrollController();
  // Sections, by "tab|question|site".
  final Map<String, Future<Json>> _sectionCache = {};

  AdvisorApi get _api => ref.read(advisorApiProvider);

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _tabs.dispose();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final me = await _api.me();
      final brief = await _api.briefing(site: _site);
      if (!mounted) return;
      setState(() {
        _me = me;
        _brief = brief;
      });
      _loadConvos();
    } on TapApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _loadConvos() async {
    try {
      final list = await _api.conversations();
      if (mounted) setState(() => _convos = list);
    } on TapApiError {
      // The list is a convenience; the chat works without it.
    }
  }

  Future<void> _send(String question) async {
    question = question.trim();
    if (question.isEmpty || _busy) return;
    _tabs.animateTo(1);
    setState(() {
      _busy = true;
      _thread.add({'question': question, 'pending': true});
    });
    _toEnd();
    try {
      final a = await _api.ask(question, conversationId: _convo, site: _site);
      setState(() {
        _convo = (a['conversation_id'] as num?)?.toInt();
        _thread[_thread.length - 1] = a;
      });
      _loadConvos();
    } on TapApiError catch (e) {
      setState(() => _thread[_thread.length - 1] = {'question': question, 'headline': 'That did not work.', 'why': [e.message]});
    } finally {
      if (mounted) setState(() => _busy = false);
      _toEnd();
    }
  }

  void _toEnd() => WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scroll.hasClients) _scroll.animateTo(_scroll.position.maxScrollExtent, duration: const Duration(milliseconds: 300), curve: Curves.easeOut);
      });

  Future<void> _openConvo(int id) async {
    try {
      final c = await _api.conversation(id);
      setState(() {
        _convo = id;
        _thread
          ..clear()
          ..addAll(maps(c['messages']));
      });
      _toEnd();
    } on TapApiError catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  Future<void> _records(Json rec) async {
    final future = _api.records(rec, site: _site);
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (c) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: .7,
        maxChildSize: .95,
        builder: (c, scroll) => FutureBuilder<Json>(
          future: future,
          builder: (c, snap) {
            if (snap.hasError) return Padding(padding: const EdgeInsets.all(20), child: Text('${snap.error}'));
            if (!snap.hasData) return const Center(child: CircularProgressIndicator());
            final r = snap.data!;
            final rows = (r['rows'] as List? ?? const []).map((x) => (x as List).map((e) => '$e').toList()).toList();
            return ListView(controller: scroll, padding: const EdgeInsets.fromLTRB(16, 0, 16, 24), children: [
              Text('${rec['label']}', style: Theme.of(c).textTheme.titleLarge),
              const SizedBox(height: 4),
              Text('${rows.length} rows · ${r['site']}${r['truncated'] == true ? ' · the latest 300' : ''} · straight from your sales',
                  style: TextStyle(color: c.goMuted)),
              const SizedBox(height: 12),
              RecordsTable(columns: strings(r['columns']), rows: rows),
            ]);
          },
        ),
      ),
    );
  }

  Future<void> _invite() async {
    final me = _me;
    if (me == null) return;
    final email = TextEditingController();
    final name = TextEditingController();
    final sites = maps(me['sites']);
    final picked = <int>{for (final s in sites) (s['id'] as num).toInt()};
    var profit = false;
    var staff = false;
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => StatefulBuilder(
        builder: (c, set) => AlertDialog(
          title: const Text('Invite to Vesopa AI'),
          content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('An email from info@vesopasoftware.com. They see Vesopa AI only, read-only.', style: TextStyle(color: c.goMuted)),
              const SizedBox(height: 12),
              TextField(controller: email, keyboardType: TextInputType.emailAddress, decoration: const InputDecoration(labelText: 'Email')),
              const SizedBox(height: 10),
              TextField(controller: name, decoration: const InputDecoration(labelText: 'Name (optional)')),
              if (sites.length > 1) ...[
                const SizedBox(height: 10),
                const Text('Sites', style: TextStyle(fontWeight: FontWeight.w700)),
                for (final s in sites)
                  CheckboxListTile(
                    contentPadding: EdgeInsets.zero,
                    value: picked.contains((s['id'] as num).toInt()),
                    title: Text('${s['name']}'),
                    onChanged: (v) => set(() => v == true ? picked.add((s['id'] as num).toInt()) : picked.remove((s['id'] as num).toInt())),
                  ),
              ],
              SwitchListTile(contentPadding: EdgeInsets.zero, value: profit, title: const Text('Profit and margins'), onChanged: (v) => set(() => profit = v)),
              SwitchListTile(contentPadding: EdgeInsets.zero, value: staff, title: const Text('Staff performance'), onChanged: (v) => set(() => staff = v)),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Send')),
          ],
        ),
      ),
    );
    if (ok != true || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      final r = await _api.invite(
        email: email.text.trim(),
        name: name.text.trim().isEmpty ? null : name.text.trim(),
        sites: picked.length == sites.length ? const [] : picked.toList(),
        profit: profit,
        staff: staff,
      );
      messenger.showSnackBar(SnackBar(content: Text(r['sent'] == true ? 'Invitation sent to ${email.text.trim()}' : 'The email did not send. Link: ${r['link']}')));
    } on TapApiError catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final can = (_me?['can'] as Map?) ?? const {};
    final sites = maps(_me?['sites']);
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 8,
        title: const Row(children: [AiMark(size: 28), SizedBox(width: 10), Text('Vesopa AI')]),
        actions: [
          if (sites.length > 1)
            PopupMenuButton<String>(
              tooltip: 'Site',
              icon: const Icon(Icons.storefront_rounded),
              onSelected: (v) {
                setState(() {
                  _site = v.isEmpty ? null : v;
                  _brief = null;
                  _sectionCache.clear();
                });
                _load();
              },
              itemBuilder: (_) => [
                CheckedPopupMenuItem(value: '', checked: _site == null, child: Text(_me?['all_sites'] == true ? 'All sites' : 'All your sites')),
                for (final s in sites) CheckedPopupMenuItem(value: '${s['id']}', checked: _site == '${s['id']}', child: Text('${s['name']}')),
              ],
            ),
          if (can['invite'] == true) IconButton(tooltip: 'Invite people', icon: const Icon(Icons.person_add_alt_1_rounded), onPressed: _invite),
        ],
        bottom: TabBar(
          controller: _tabs,
          isScrollable: true,
          tabAlignment: TabAlignment.start,
          indicatorColor: Tp.lime,
          labelColor: context.aiInk,
          labelStyle: const TextStyle(fontWeight: FontWeight.w800),
          tabs: const [Tab(text: 'Briefing'), Tab(text: 'Ask'), Tab(text: 'Sales'), Tab(text: 'Stock'), Tab(text: 'Profit'), Tab(text: 'Team')],
        ),
      ),
      body: _error != null
          ? _Problem(message: _error!, onRetry: _load)
          : TabBarView(controller: _tabs, children: [
              _briefing(),
              _ask(),
              for (final name in _sections.keys)
                name == 'Profit' && can['profit'] != true
                    ? const _Problem(message: 'Profit figures are not shared with you.')
                    : _section(name, can),
            ]),
    );
  }

  // ---- briefing ----

  Widget _briefing() {
    final b = _brief;
    if (b == null) return const _Thinking(text: 'Reading today\'s figures…');
    final t = Theme.of(context).textTheme;
    final tiles = maps(b['tiles']);
    final alerts = maps(b['alerts']);
    final first = '${_me?['name'] ?? ''}'.split(' ').first;
    final hour = DateTime.now().hour;
    return RefreshIndicator(
      onRefresh: _load,
      child: _Width(
        child: ListView(padding: const EdgeInsets.all(16), children: [
          Card(
            child: Container(
              decoration: BoxDecoration(border: Border(left: BorderSide(color: Tp.lime, width: 4))),
              padding: const EdgeInsets.all(16),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}${first.isEmpty ? '' : ', $first'}'.toUpperCase(),
                    style: t.labelSmall?.copyWith(color: context.aiInk, fontWeight: FontWeight.w800, letterSpacing: .6)),
                const SizedBox(height: 6),
                Text('${b['headline']}', style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w800, height: 1.2)),
                const SizedBox(height: 8),
                for (final w in strings(b['why'])) Padding(padding: const EdgeInsets.only(bottom: 4), child: Text(w, style: const TextStyle(fontSize: 15, height: 1.4))),
              ]),
            ),
          ),
          const SizedBox(height: 12),
          LayoutBuilder(builder: (c, box) {
            final cols = box.maxWidth >= 640 ? 4 : 2;
            final w = (box.maxWidth - (cols - 1) * 10) / cols;
            return Wrap(spacing: 10, runSpacing: 10, children: [for (final tile in tiles) SizedBox(width: w, child: _Tile(tile: tile))]);
          }),
          const SizedBox(height: 12),
          if (alerts.isNotEmpty)
            Card(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  Text('Needs your attention', style: t.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
                  const SizedBox(height: 6),
                  for (final a in alerts)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: Container(width: 12, height: 12, decoration: BoxDecoration(shape: BoxShape.circle, color: a['level'] == 'bad' ? Tp.danger : a['level'] == 'good' ? Tp.green : Tp.amber)),
                      minLeadingWidth: 12,
                      title: Text('${a['title']}', style: const TextStyle(fontWeight: FontWeight.w700)),
                      subtitle: Text('${a['body']}'),
                      trailing: Text('Ask why ›', style: TextStyle(color: context.aiInk, fontWeight: FontWeight.w800)),
                      onTap: () => _send('${a['ask']}'),
                    ),
                ]),
              ),
            ),
          const SizedBox(height: 12),
          AnswerCard(answer: {...b, 'headline': 'What you could do', 'why': const []}, onRecords: _records),
          const SizedBox(height: 16),
          Text('Ask Vesopa AI', style: t.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: 8),
          SuggestionChips(questions: strings(b['follow_ups']), onAsk: _send),
          const SizedBox(height: 24),
        ]),
      ),
    );
  }

  // ---- ask ----

  Widget _ask() {
    final wide = MediaQuery.sizeOf(context).width >= 900;
    final chat = Column(children: [
      Expanded(
        child: _thread.isEmpty
            ? ListView(padding: const EdgeInsets.all(16), children: [
                const SizedBox(height: 24),
                const Center(child: AiMark(size: 52)),
                const SizedBox(height: 12),
                Text('Ask about your business', textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
                const SizedBox(height: 6),
                Text('Every answer is worked out from your own sales, with the period, the site and the records behind it.',
                    textAlign: TextAlign.center, style: TextStyle(color: context.goMuted)),
                const SizedBox(height: 16),
                SuggestionChips(questions: _suggested, onAsk: _send),
                if (!wide && _convos.isNotEmpty) ...[
                  const SizedBox(height: 24),
                  Text('Earlier conversations', style: TextStyle(color: context.goMuted, fontWeight: FontWeight.w700)),
                  for (final c in _convos.take(6)) _convoTile(c),
                ],
              ])
            : ListView.builder(
                controller: _scroll,
                padding: const EdgeInsets.all(12),
                itemCount: _thread.length,
                itemBuilder: (c, i) {
                  final a = _thread[i];
                  return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    Align(
                      alignment: Alignment.centerRight,
                      child: Container(
                        margin: const EdgeInsets.only(left: 48, bottom: 8, top: 4),
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                        decoration: BoxDecoration(color: Tp.lime, borderRadius: const BorderRadius.only(topLeft: Radius.circular(16), topRight: Radius.circular(16), bottomLeft: Radius.circular(16), bottomRight: Radius.circular(4))),
                        child: Text('${a['question'] ?? ''}', style: TextStyle(color: Tp.onLime, fontWeight: FontWeight.w700)),
                      ),
                    ),
                    if (a['pending'] == true) const _Thinking(text: 'Working it out from your sales…', small: true) else AnswerCard(answer: a, onAsk: _send, onRecords: _records),
                    const SizedBox(height: 8),
                  ]);
                },
              ),
      ),
      SafeArea(
        top: false,
        child: Container(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
          decoration: BoxDecoration(color: context.goCard, border: Border(top: BorderSide(color: context.goLine))),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            if (_thread.isNotEmpty && _thread.last['pending'] != true)
              SizedBox(
                height: 44,
                child: ListView(scrollDirection: Axis.horizontal, children: [
                  for (final q in strings(_thread.last['follow_ups']))
                    Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: ActionChip(
                        label: Text(q, style: TextStyle(color: context.aiInk, fontWeight: FontWeight.w700)),
                        backgroundColor: Tp.lime.withValues(alpha: 0.14),
                        side: BorderSide.none,
                        onPressed: () => _send(q),
                      ),
                    ),
                ]),
              ),
            Row(children: [
              Expanded(
                child: TextField(
                  controller: _input,
                  textInputAction: TextInputAction.send,
                  minLines: 1,
                  maxLines: 3,
                  decoration: const InputDecoration(hintText: 'Why did sales drop yesterday?', contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 14)),
                  onSubmitted: (v) {
                    _input.clear();
                    _send(v);
                  },
                ),
              ),
              const SizedBox(width: 8),
              IconButton.filled(
                style: IconButton.styleFrom(backgroundColor: Tp.lime, foregroundColor: Tp.onLime, minimumSize: const Size(52, 52)),
                tooltip: 'Ask',
                icon: _busy ? SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2.5, color: Tp.onLime)) : const Icon(Icons.arrow_upward_rounded),
                onPressed: _busy
                    ? null
                    : () {
                        final v = _input.text;
                        _input.clear();
                        _send(v);
                      },
              ),
            ]),
          ]),
        ),
      ),
    ]);
    if (!wide) return chat;
    return Row(children: [
      SizedBox(
        width: 280,
        child: Container(
          decoration: BoxDecoration(border: Border(right: BorderSide(color: context.goLine))),
          child: ListView(padding: const EdgeInsets.all(12), children: [
            Row(children: [
              Expanded(child: Text('Conversations', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800))),
              TextButton.icon(
                icon: const Icon(Icons.add_rounded),
                label: const Text('New'),
                onPressed: () => setState(() {
                  _convo = null;
                  _thread.clear();
                }),
              ),
            ]),
            if (_convos.isEmpty) Padding(padding: const EdgeInsets.all(8), child: Text('Your questions are kept here, for you only.', style: TextStyle(color: context.goMuted))),
            for (final c in _convos) _convoTile(c),
          ]),
        ),
      ),
      Expanded(child: _Width(child: chat)),
    ]);
  }

  Widget _convoTile(Json c) => ListTile(
        dense: true,
        selected: (c['id'] as num?)?.toInt() == _convo,
        selectedTileColor: Tp.lime.withValues(alpha: 0.14),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        title: Text('${c['title']}', maxLines: 1, overflow: TextOverflow.ellipsis),
        subtitle: Text('${'${c['updated_at']}'.substring(0, 16)} · ${c['messages']}'),
        onTap: () => _openConvo((c['id'] as num).toInt()),
      );

  // ---- sections ----

  Widget _section(String name, Map can) {
    final qs = _sections[name]!.where((q) => !(RegExp('team|staff', caseSensitive: false).hasMatch(q) && can['staff'] != true)).toList();
    return _Width(
      child: ListView(padding: const EdgeInsets.all(16), children: [
        for (final q in qs) ...[
          FutureBuilder<Json>(
            future: _sectionCache.putIfAbsent('$name|$q|$_site', () => _api.ask(q, site: _site, save: false)),
            builder: (c, snap) {
              if (snap.hasError) return Card(child: Padding(padding: const EdgeInsets.all(16), child: Text('${snap.error}')));
              if (!snap.hasData) return _Thinking(text: q, small: true);
              return AnswerCard(answer: snap.data!, kicker: q, onAsk: _send, onRecords: _records);
            },
          ),
          const SizedBox(height: 12),
        ],
      ]),
    );
  }
}

/// A readable width on a tablet: answers do not stretch across a 13-inch iPad.
class _Width extends StatelessWidget {
  const _Width({required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) => Align(alignment: Alignment.topCenter, child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 820), child: child));
}

class _Tile extends StatelessWidget {
  const _Tile({required this.tile});
  final Json tile;
  @override
  Widget build(BuildContext context) {
    final change = tile['change'] as num?;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${tile['label']}'.toUpperCase(), style: TextStyle(fontSize: 11, letterSpacing: .6, color: context.goMuted, fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: Text(moneyText((tile['value'] as num?) ?? 0), style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w800, fontFeatures: Tp.tabular))),
          const SizedBox(height: 2),
          Text(
            change == null ? 'no comparison' : '${change >= 0 ? '▲' : '▼'} ${change.abs()}%',
            style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13, color: change == null ? context.goMuted : change >= 0 ? Tp.green : Tp.danger),
          ),
          Text('${tile['sub'] ?? ''}', style: TextStyle(fontSize: 12, color: context.goMuted)),
        ]),
      ),
    );
  }
}

class _Thinking extends StatelessWidget {
  const _Thinking({required this.text, this.small = false});
  final String text;
  final bool small;
  @override
  Widget build(BuildContext context) {
    final row = Row(mainAxisSize: MainAxisSize.min, children: [
      SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2.5, color: Tp.lime)),
      const SizedBox(width: 12),
      Flexible(child: Text(text, style: TextStyle(color: context.goMuted))),
    ]);
    if (small) return Card(child: Padding(padding: const EdgeInsets.all(16), child: row));
    return Center(child: row);
  }
}

class _Problem extends StatelessWidget {
  const _Problem({required this.message, this.onRetry});
  final String message;
  final VoidCallback? onRetry;
  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const AiMark(size: 44),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center),
            if (onRetry != null) ...[const SizedBox(height: 12), OutlinedButton(onPressed: onRetry, child: const Text('Try again'))],
          ]),
        ),
      );
}

/// The way in, on More: a card a manager sees first.
class VesopaAiTile extends ConsumerWidget {
  const VesopaAiTile({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final clerk = ref.watch(tapProvider.select((s) => s.clerk));
    final demo = ref.watch(tapProvider.select((s) => s.demo));
    if (demo || clerk == null || !clerk.can(TillPermission.isManager)) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Card(
        child: ListTile(
          contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          leading: const AiMark(size: 44),
          title: const Text('Vesopa AI', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
          subtitle: const Text('Your business, explained: today\'s briefing, and answers about sales, stock, profit and the team'),
          trailing: const Icon(Icons.chevron_right_rounded),
          onTap: () => openVesopaAi(context, ref),
        ),
      ),
    );
  }
}
