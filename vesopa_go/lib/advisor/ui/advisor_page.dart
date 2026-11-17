/// Vesopa AI: "Don't just see your business. Understand it."
///
///   Briefing  today so far, yesterday and why, what needs attention, what to do
///   Ask       questions in plain words, with follow-ups and the history on this device
///   Sales     takings, comparisons, why they moved, busiest hours
///   Profit    margins, best earners, products selling below cost
///   Stock     what runs out when, what to reorder, fast and slow movers
///   People    staff performance and branches (sites, or tills when there are none)
///
/// Every figure comes from the venue's own Vesopa EPOS data, worked out by
/// the server; Vesopa AI explains it and never changes anything. Only for a
/// real venue: the demo has no business behind it, so it says so.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/api.dart';
import '../../data/session.dart';
import '../../ui/theme.dart';
import '../advisor_state.dart';
import 'advisor_widgets.dart';
import 'answer_view.dart';

const _maxWidth = 1100.0;

/// A label mid-sentence: only its first letter lowered ("Last Tuesday" keeps its capital T).
String _lc(String s) => s.isEmpty ? s : s[0].toLowerCase() + s.substring(1);

class AdvisorPage extends ConsumerStatefulWidget {
  const AdvisorPage({super.key});
  @override
  ConsumerState<AdvisorPage> createState() => _AdvisorPageState();
}

class _AdvisorPageState extends ConsumerState<AdvisorPage> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && !ref.read(tapProvider).demo) ref.read(advisorProvider.notifier).open();
    });
  }

  @override
  Widget build(BuildContext context) {
    final tap = ref.watch(tapProvider);
    final a = ref.watch(advisorProvider);
    if (tap.demo) {
      return const _Notice(
        icon: Icons.auto_awesome_rounded,
        title: 'Vesopa AI needs a real venue',
        text: 'Vesopa AI answers from your own Vesopa EPOS sales, stock and staff, so it is not part of the demo. Sign this device in to your venue to use it.',
      );
    }
    return switch (a.phase) {
      AdvisorPhase.ready => const _Advisor(),
      AdvisorPhase.notInvited => const _NotInvited(),
      AdvisorPhase.offline => _Notice(
          icon: Icons.cloud_off_rounded,
          title: 'Vesopa AI needs a connection',
          text: 'It reads your figures from the back office as you ask. Check the wifi or mobile data.',
          action: ('Try again', () => ref.read(advisorProvider.notifier).open(force: true)),
        ),
      AdvisorPhase.error => _Notice(
          icon: Icons.error_outline_rounded,
          title: 'Vesopa AI could not open',
          text: a.message ?? 'Something went wrong.',
          action: ('Try again', () => ref.read(advisorProvider.notifier).open(force: true)),
        ),
      _ => const Center(child: CircularProgressIndicator()),
    };
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.icon, required this.title, required this.text, this.action});
  final IconData icon;
  final String title;
  final String text;
  final (String, VoidCallback)? action;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(32),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 440),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Icon(icon, size: 48, color: context.goLimeInk),
            const SizedBox(height: 12),
            Text(title, style: t.titleLarge, textAlign: TextAlign.center),
            const SizedBox(height: 8),
            Text(text, textAlign: TextAlign.center),
            if (action != null) ...[
              const SizedBox(height: 20),
              FilledButton(onPressed: action!.$2, child: Text(action!.$1)),
            ],
          ]),
        ),
      ),
    );
  }
}

/// Not a manager and not invited: how to get in.
class _NotInvited extends ConsumerWidget {
  const _NotInvited();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final name = ref.watch(tapProvider).clerk?.name ?? 'You';
    return _Notice(
      icon: Icons.lock_rounded,
      title: 'Vesopa AI is for managers',
      text: '$name can use it once a manager or the owner invites you. They send the invite to your email from Vesopa AI, and you type the code here.',
      action: (
        'I have an invite code',
        () async {
          final code = await _askCode(context);
          if (code == null || !context.mounted) return;
          final error = await ref.read(advisorProvider.notifier).redeem(code);
          if (error != null && context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error)));
        },
      ),
    );
  }

  Future<String?> _askCode(BuildContext context) {
    final c = TextEditingController();
    return showDialog<String>(
      context: context,
      builder: (d) => AlertDialog(
        icon: const Icon(Icons.mark_email_read_rounded),
        title: const Text('Your invite code'),
        content: TextField(
          controller: c,
          autofocus: true,
          textCapitalization: TextCapitalization.characters,
          style: const TextStyle(fontSize: 22, letterSpacing: 4, fontWeight: FontWeight.w800),
          decoration: const InputDecoration(hintText: 'ABCD2345', helperText: 'The 8 characters from the email'),
          onSubmitted: (v) => Navigator.pop(d, v),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(d, c.text), child: const Text('Use code')),
        ],
      ),
    );
  }
}

// ---- the advisor --------------------------------------------------------------------

class _Advisor extends ConsumerStatefulWidget {
  const _Advisor();
  @override
  ConsumerState<_Advisor> createState() => _AdvisorState();
}

class _AdvisorState extends ConsumerState<_Advisor> with SingleTickerProviderStateMixin {
  static const _tabs = [
    (Icons.wb_sunny_rounded, 'Briefing'),
    (Icons.forum_rounded, 'Ask'),
    (Icons.show_chart_rounded, 'Sales'),
    (Icons.savings_rounded, 'Profit'),
    (Icons.inventory_2_rounded, 'Stock'),
    (Icons.groups_rounded, 'People'),
  ];
  late final TabController _tab = TabController(length: _tabs.length, vsync: this);

  @override
  void dispose() {
    _tab.dispose();
    super.dispose();
  }

  void _go(String where) {
    final i = switch (where) { 'ask' => 1, 'sales' => 2, 'profit' => 3, 'stock' => 4, 'staff' || 'people' => 5, _ => 0 };
    _tab.animateTo(i);
  }

  void _ask(String q) {
    _tab.animateTo(1);
    ref.read(advisorChatProvider.notifier).ask(q);
  }

  @override
  Widget build(BuildContext context) {
    final a = ref.watch(advisorProvider);
    final session = a.session!;
    final t = Theme.of(context).textTheme;
    return Column(children: [
      Material(
        color: Theme.of(context).colorScheme.surface,
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: _maxWidth),
            child: Column(children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 8, 0),
                child: Row(children: [
                  const AiMark(size: 30),
                  const SizedBox(width: 10),
                  // Go's own top bar already says "Vesopa AI": here, only what it is for.
                  Expanded(
                    child: Text('Don\'t just see your business. Understand it.',
                        style: t.bodyMedium?.copyWith(color: context.goMuted, fontWeight: FontWeight.w600), maxLines: 2, overflow: TextOverflow.ellipsis),
                  ),
                  _SitePicker(session: session, site: a.site),
                  PopupMenuButton<String>(
                    tooltip: 'More',
                    onSelected: (v) {
                      if (v == 'invites') Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const AdvisorInvitesPage()));
                      if (v == 'clear') ref.read(advisorChatProvider.notifier).clear();
                      if (v == 'about') _about(context, session);
                    },
                    itemBuilder: (_) => [
                      if (session.canInvite) const PopupMenuItem(value: 'invites', child: ListTile(leading: Icon(Icons.person_add_alt_1_rounded), title: Text('Invite people'))),
                      const PopupMenuItem(value: 'clear', child: ListTile(leading: Icon(Icons.delete_sweep_rounded), title: Text('Clear conversation'))),
                      const PopupMenuItem(value: 'about', child: ListTile(leading: Icon(Icons.verified_user_rounded), title: Text('About your data'))),
                    ],
                  ),
                ]),
              ),
              TabBar(
                controller: _tab,
                isScrollable: true,
                tabAlignment: TabAlignment.start,
                indicatorColor: Tp.lime,
                labelColor: context.goText,
                unselectedLabelColor: context.goMuted,
                labelStyle: const TextStyle(fontWeight: FontWeight.w800),
                tabs: [for (final (icon, label) in _tabs) Tab(height: 52, icon: null, child: Row(mainAxisSize: MainAxisSize.min, children: [Icon(icon, size: 18), const SizedBox(width: 6), Text(label)]))],
              ),
            ]),
          ),
        ),
      ),
      Divider(height: 1, color: context.goLine),
      Expanded(
        child: TabBarView(controller: _tab, children: [
          _Briefing(onGo: _go, onAsk: _ask),
          const _Ask(),
          _Insights(key: const ValueKey('sales'), intents: const ['summary', 'why_change', 'hours'], onAsk: _ask),
          _Insights(key: const ValueKey('profit'), intents: const ['profit', 'top_products', 'loss_makers'], defaultPeriod: 'last_30_days', onAsk: _ask),
          _Insights(key: const ValueKey('stock'), intents: const ['stock', 'stock_movers'], periods: false, onAsk: _ask),
          _Insights(key: const ValueKey('people'), intents: const ['staff', 'branches'], defaultPeriod: 'this_week', onAsk: _ask),
        ]),
      ),
    ]);
  }

  void _about(BuildContext context, AdvisorSession s) => showDialog<void>(
        context: context,
        builder: (c) => AlertDialog(
          icon: const Icon(Icons.verified_user_rounded),
          title: const Text('About your data'),
          content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('Every figure is calculated by the Vesopa server from this venue\'s own EPOS records: closed sales, products, stock and staff. Nothing is estimated or made up.'),
              const SizedBox(height: 10),
              Text(s.aiOn
                  ? 'An AI model words the explanations. It is sent the figures only, with staff names replaced by "Staff A", "Staff B", and never customer details. If it quotes a figure that is not in your data, its answer is discarded.'
                  : (s.aiWhy ?? 'Explanations use plain wording made from the figures.')),
              const SizedBox(height: 10),
              const Text('Vesopa AI is read-only. It suggests; any change to prices, stock, orders or staff is made by a manager, where it is approved today.'),
              const SizedBox(height: 10),
              Text(s.role == 'manager'
                  ? 'You can see every site as a manager.'
                  : (s.site == null ? 'You were invited to see the whole venue.' : 'You were invited to see ${s.sites.isEmpty ? 'one site' : s.sites.first.name} only.')),
              const SizedBox(height: 10),
              const Text('Your questions are kept on this device only.'),
            ]),
          ),
          actions: [TextButton(onPressed: () => Navigator.pop(c), child: const Text('Done'))],
        ),
      );
}

class _SitePicker extends ConsumerWidget {
  const _SitePicker({required this.session, required this.site});
  final AdvisorSession session;
  final int? site;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (session.sites.isEmpty) return const SizedBox.shrink();
    final locked = session.site != null;
    final name = site == null ? 'All sites' : session.sites.where((s) => s.id == site).map((s) => s.name).firstOrNull ?? 'Site';
    final label = Row(mainAxisSize: MainAxisSize.min, children: [
      Icon(locked ? Icons.lock_rounded : Icons.storefront_rounded, size: 18),
      const SizedBox(width: 6),
      ConstrainedBox(constraints: const BoxConstraints(maxWidth: 120), child: Text(name, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700))),
      if (!locked) const Icon(Icons.arrow_drop_down_rounded),
    ]);
    if (locked) return Tooltip(message: 'Your invite is for this site', child: Padding(padding: const EdgeInsets.symmetric(horizontal: 8), child: label));
    return PopupMenuButton<int>(
      tooltip: 'Which site',
      initialValue: site ?? -1,
      onSelected: (v) => ref.read(advisorProvider.notifier).chooseSite(v == -1 ? null : v),
      itemBuilder: (_) => [
        const PopupMenuItem(value: -1, child: Text('All sites')),
        for (final s in session.sites) PopupMenuItem(value: s.id, child: Text(s.name)),
      ],
      child: Padding(padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10), child: label),
    );
  }
}

/// A scrolling page of the advisor's width, centred on a wide screen.
class _Page extends StatelessWidget {
  const _Page({required this.children, this.onRefresh});
  final List<Widget> children;
  final Future<void> Function()? onRefresh;

  @override
  Widget build(BuildContext context) {
    final list = ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
      children: [
        Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: _maxWidth),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
          ),
        ),
      ],
    );
    return onRefresh == null ? list : RefreshIndicator(color: Tp.lime, onRefresh: onRefresh!, child: list);
  }
}

// ---- briefing -------------------------------------------------------------------------

class _Briefing extends ConsumerStatefulWidget {
  const _Briefing({required this.onGo, required this.onAsk});
  final ValueChanged<String> onGo;
  final ValueChanged<String> onAsk;
  @override
  ConsumerState<_Briefing> createState() => _BriefingState();
}

class _BriefingState extends ConsumerState<_Briefing> with AutomaticKeepAliveClientMixin {
  Map<String, dynamic>? _b;
  String? _error;
  int? _site;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _site = ref.read(advisorProvider).site;
    _load();
  }

  Future<void> _load() async {
    final a = ref.read(advisorProvider);
    try {
      final b = await ref.read(apiProvider).aiBriefing(a.session!.token, site: a.site);
      if (mounted) {
        setState(() {
          _b = b;
          _error = null;
        });
      }
    } on TapApiError catch (e) {
      if (await ref.read(advisorProvider.notifier).reopenAfter(e)) return _load();
      if (mounted) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final site = ref.watch(advisorProvider.select((a) => a.site));
    if (site != _site) {
      _site = site;
      _b = null;
      _load();
    }
    final t = Theme.of(context).textTheme;
    final b = _b;
    if (_error != null) return _Notice(icon: Icons.error_outline_rounded, title: 'No briefing just now', text: _error!, action: ('Try again', _load));
    if (b == null) return const _Loading(label: 'Reading today\'s figures…');
    final ai = (b['ai'] as Map?)?.cast<String, dynamic>();
    final today = (b['today'] as Map).cast<String, dynamic>();
    final yesterday = (b['yesterday'] as Map).cast<String, dynamic>();
    final alerts = [for (final x in (b['alerts'] as List? ?? const [])) (x as Map).cast<String, dynamic>()];
    final actions = [for (final x in (b['actions'] as List? ?? const [])) (x as Map).cast<String, dynamic>()];
    final todayCards = [for (final x in (today['cards'] as List? ?? const [])) (x as Map).cast<String, dynamic>()];
    final yCards = [for (final x in (yesterday['cards'] as List? ?? const [])) (x as Map).cast<String, dynamic>()];
    final meta = (b['meta'] as Map).cast<String, dynamic>();
    return _Page(onRefresh: _load, children: [
      // The briefing itself.
      Container(
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(
          color: Tp.lime.withValues(alpha: context.goDark ? 0.12 : 0.16),
          borderRadius: BorderRadius.circular(Tp.radius),
          border: Border.all(color: Tp.lime.withValues(alpha: 0.45)),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            const AiMark(size: 22),
            const SizedBox(width: 8),
            Expanded(child: Text('${b['greeting']}, ${b['name']}', style: t.titleMedium?.copyWith(fontWeight: FontWeight.w800))),
          ]),
          const SizedBox(height: 10),
          Text(ai?['answer'] as String? ?? '${b['headline']}', style: t.titleMedium?.copyWith(height: 1.4, fontWeight: FontWeight.w600)),
          if (ai != null) ...[
            for (final w in (ai['why'] as List? ?? const []))
              Padding(padding: const EdgeInsets.only(top: 6), child: Text('• $w', style: t.bodyMedium)),
          ],
          const SizedBox(height: 12),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final q in const ['Why did sales change yesterday?', 'What should I focus on tomorrow?', 'What stock should I reorder?'])
              ActionChip(label: Text(q), onPressed: () => widget.onAsk(q)),
          ]),
        ]),
      ),
      const SizedBox(height: 12),
      AiColumns(children: [
        AiSection(title: 'Today so far', subtitle: 'Against ${_lc(today['compare'] as String? ?? '')}', children: [
          for (final c in todayCards) ...[
            if (c['type'] == 'kpis') AiStatGrid(items: [for (final x in (c['items'] as List)) (x as Map).cast<String, dynamic>()]) else AiBars(card: c),
            const SizedBox(height: 12),
          ],
        ]),
        AiSection(title: 'Yesterday', subtitle: '${yesterday['label']}', children: [
          Text('${yesterday['headline']}', style: t.bodyMedium?.copyWith(fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          for (final w in (yesterday['why'] as List? ?? const []).take(3)) Padding(padding: const EdgeInsets.only(bottom: 4), child: Text('• $w', style: t.bodySmall)),
          for (final c in yCards.where((c) => c['type'] == 'drivers')) ...[const SizedBox(height: 8), AiDrivers(card: c)],
          Align(
            alignment: Alignment.centerRight,
            child: TextButton.icon(
              style: TextButton.styleFrom(foregroundColor: context.goLimeInk),
              onPressed: () => widget.onAsk('Why did sales change yesterday?'),
              icon: const Icon(Icons.auto_awesome_rounded, size: 18),
              label: const Text('Explain yesterday'),
            ),
          ),
        ]),
        if (alerts.isNotEmpty) AiSection(title: 'Needs attention', subtitle: 'Last 7 days and stock', children: [AiAlerts(items: alerts)]),
        AiSection(title: 'What you could do', subtitle: 'From the last 7 days against the 7 before', children: [
          if (actions.isEmpty) Text('Nothing stands out: sales, stock and margins look steady.', style: t.bodyMedium),
          for (var i = 0; i < actions.length; i++)
            AiSuggestion(index: i + 1, title: '${actions[i]['title']}', why: actions[i]['why'] as String?, onOpen: () => widget.onGo('${actions[i]['action'] ?? 'sales'}')),
        ]),
      ]),
      const SizedBox(height: 4),
      AnswerMeta(
        meta: meta,
        aiNote: b['ai_note'] as String?,
        onViewData: () => showRecords(context, ref, source: 'orders', period: 'today', site: (meta['site'] as Map?)?['id'] as int?),
      ),
    ]);
  }
}

class _Loading extends StatelessWidget {
  const _Loading({required this.label});
  final String label;

  @override
  Widget build(BuildContext context) => Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const AiMark(size: 40),
          const SizedBox(height: 14),
          const SizedBox(width: 140, child: LinearProgressIndicator()),
          const SizedBox(height: 10),
          Text(label, style: Theme.of(context).textTheme.bodySmall),
        ]),
      );
}

// ---- ask -------------------------------------------------------------------------------

class _Ask extends ConsumerStatefulWidget {
  const _Ask();
  @override
  ConsumerState<_Ask> createState() => _AskState();
}

class _AskState extends ConsumerState<_Ask> with AutomaticKeepAliveClientMixin {
  final _text = TextEditingController();
  final _scroll = ScrollController();
  final _focus = FocusNode();

  @override
  bool get wantKeepAlive => true;

  @override
  void dispose() {
    _text.dispose();
    _scroll.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _send([String? q]) {
    final text = (q ?? _text.text).trim();
    if (text.isEmpty) return;
    _text.clear();
    ref.read(advisorChatProvider.notifier).ask(text);
  }

  void _toEnd() => WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scroll.hasClients) _scroll.animateTo(_scroll.position.maxScrollExtent, duration: const Duration(milliseconds: 300), curve: Curves.easeOut);
      });

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final turns = ref.watch(advisorChatProvider);
    final session = ref.watch(advisorProvider).session!;
    ref.listen(advisorChatProvider, (prev, next) {
      if ((prev?.length ?? 0) != next.length || (next.isNotEmpty && !next.last.pending)) _toEnd();
    });
    final t = Theme.of(context).textTheme;
    final busy = turns.isNotEmpty && turns.last.pending;
    return Column(children: [
      Expanded(
        child: turns.isEmpty
            ? _Page(children: [
                const SizedBox(height: 8),
                const Center(child: AiMark(size: 48)),
                const SizedBox(height: 14),
                Text('Ask about your business', style: t.titleLarge, textAlign: TextAlign.center),
                const SizedBox(height: 6),
                Text('Answers come from your own Vesopa EPOS figures, with the charts and the records behind them.', style: t.bodyMedium?.copyWith(color: context.goMuted), textAlign: TextAlign.center),
                const SizedBox(height: 20),
                Wrap(alignment: WrapAlignment.center, spacing: 8, runSpacing: 8, children: [
                  for (final q in session.suggestions) ActionChip(avatar: Icon(Icons.auto_awesome_rounded, size: 16, color: context.goLimeInk), label: Text(q), onPressed: () => _send(q)),
                ]),
              ])
            : ListView.builder(
                controller: _scroll,
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 16),
                itemCount: turns.length,
                itemBuilder: (_, i) => Center(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 820),
                    child: _Turn(turn: turns[i], onFollowUp: busy ? null : _send, last: i == turns.length - 1),
                  ),
                ),
              ),
      ),
      Divider(height: 1, color: context.goLine),
      SafeArea(
        top: false,
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 820),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
              child: Row(children: [
                Expanded(
                  child: TextField(
                    controller: _text,
                    focusNode: _focus,
                    enabled: !busy,
                    minLines: 1,
                    maxLines: 4,
                    textInputAction: TextInputAction.send,
                    onSubmitted: (_) => _send(),
                    decoration: const InputDecoration(hintText: 'Ask Vesopa AI about your business…', contentPadding: EdgeInsets.symmetric(horizontal: 16, vertical: 14)),
                  ),
                ),
                const SizedBox(width: 8),
                SizedBox(
                  width: Tp.target,
                  height: Tp.target,
                  child: FilledButton(
                    style: FilledButton.styleFrom(padding: EdgeInsets.zero, minimumSize: const Size(Tp.target, Tp.target)),
                    onPressed: busy ? null : _send,
                    child: busy ? SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5, color: Tp.onLime)) : const Icon(Icons.arrow_upward_rounded),
                  ),
                ),
              ]),
            ),
          ),
        ),
      ),
    ]);
  }
}

class _Turn extends StatelessWidget {
  const _Turn({required this.turn, this.onFollowUp, required this.last});
  final ChatTurn turn;
  final ValueChanged<String>? onFollowUp;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 20),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Align(
          alignment: Alignment.centerRight,
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(color: Tp.lime, borderRadius: BorderRadius.circular(16).copyWith(bottomRight: const Radius.circular(4))),
              child: Text(turn.question, style: t.bodyLarge?.copyWith(color: Tp.onLime, fontWeight: FontWeight.w600)),
            ),
          ),
        ),
        const SizedBox(height: 10),
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Padding(padding: EdgeInsets.only(top: 2), child: AiMark(size: 26)),
          const SizedBox(width: 10),
          Expanded(
            child: turn.pending
                ? Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Row(children: [
                      const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
                      const SizedBox(width: 10),
                      Text('Working it out from your figures…', style: t.bodyMedium?.copyWith(color: context.goMuted)),
                    ]),
                  )
                : turn.error != null
                    ? Text(turn.error!, style: t.bodyMedium?.copyWith(color: Tp.danger))
                    : AnswerView(answer: turn.answer!, onFollowUp: last ? onFollowUp : null),
          ),
        ]),
      ]),
    );
  }
}

// ---- the overview tabs ---------------------------------------------------------------------

const _periodNames = {
  'today': 'Today',
  'yesterday': 'Yesterday',
  'this_week': 'This week',
  'last_week': 'Last week',
  'this_month': 'This month',
  'last_30_days': '30 days',
};

class _Insights extends ConsumerStatefulWidget {
  const _Insights({super.key, required this.intents, this.defaultPeriod = 'today', this.periods = true, required this.onAsk});
  final List<String> intents;
  final String defaultPeriod;
  final bool periods;
  final ValueChanged<String> onAsk;
  @override
  ConsumerState<_Insights> createState() => _InsightsState();
}

class _InsightsState extends ConsumerState<_Insights> with AutomaticKeepAliveClientMixin {
  late String _period = widget.defaultPeriod;
  List<Map<String, dynamic>?> _answers = const [];
  String? _error;
  int? _site;
  int _run = 0;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _site = ref.read(advisorProvider).site;
    _load();
  }

  Future<void> _load() async {
    final run = ++_run;
    setState(() {
      _answers = List.filled(widget.intents.length, null);
      _error = null;
    });
    final a = ref.read(advisorProvider);
    final api = ref.read(apiProvider);
    try {
      // The figures only, fast: the wording of a model is for the Ask tab.
      final all = await Future.wait([
        for (final i in widget.intents) api.aiAsk(a.session!.token, intent: i, period: _period, site: a.site, words: false),
      ]);
      if (mounted && run == _run) setState(() => _answers = all);
    } on TapApiError catch (e) {
      if (await ref.read(advisorProvider.notifier).reopenAfter(e)) return _load();
      if (mounted && run == _run) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final site = ref.watch(advisorProvider.select((a) => a.site));
    if (site != _site) {
      _site = site;
      WidgetsBinding.instance.addPostFrameCallback((_) => _load());
    }
    return _Page(onRefresh: _load, children: [
      if (widget.periods) ...[
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(children: [
            for (final e in _periodNames.entries)
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: ChoiceChip(
                  label: Text(e.value),
                  selected: _period == e.key,
                  selectedColor: Tp.lime.withValues(alpha: 0.3),
                  onSelected: (_) {
                    if (_period == e.key) return;
                    setState(() => _period = e.key);
                    _load();
                  },
                ),
              ),
          ]),
        ),
        const SizedBox(height: 12),
      ],
      if (_error != null)
        _Notice(icon: Icons.error_outline_rounded, title: 'Could not load', text: _error!, action: ('Try again', _load))
      else
        AiColumns(children: [
          for (var i = 0; i < widget.intents.length; i++)
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: _answers.length > i && _answers[i] != null
                    ? Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                        AnswerView(answer: _answers[i]!, compact: true),
                        Align(
                          alignment: Alignment.centerRight,
                          child: TextButton.icon(
                            style: TextButton.styleFrom(foregroundColor: context.goLimeInk),
                            onPressed: () => widget.onAsk(_explain(widget.intents[i])),
                            icon: const Icon(Icons.auto_awesome_rounded, size: 18),
                            label: const Text('Explain this'),
                          ),
                        ),
                      ])
                    : const SizedBox(height: 160, child: Center(child: CircularProgressIndicator())),
              ),
            ),
        ]),
    ]);
  }

  String _explain(String intent) {
    final when = (_periodNames[_period] ?? 'today').toLowerCase();
    return switch (intent) {
      'summary' => 'How are sales $when compared with before?',
      'why_change' => 'Why did sales change $when?',
      'hours' => 'What were the busiest hours $when?',
      'profit' => 'Which products make the most profit $when?',
      'top_products' => 'What were the best sellers $when?',
      'loss_makers' => 'Any products selling below cost $when?',
      'stock' => 'What stock should I reorder?',
      'stock_movers' => 'Which products are not moving?',
      'staff' => 'How is my team performing $when?',
      'branches' => 'Which branch performed best $when?',
      _ => 'What should I focus on tomorrow?',
    };
  }
}

// ---- invites -------------------------------------------------------------------------------

/// Managers: who may use Vesopa AI besides the managers, invite by email, revoke.
class AdvisorInvitesPage extends ConsumerStatefulWidget {
  const AdvisorInvitesPage({super.key});
  @override
  ConsumerState<AdvisorInvitesPage> createState() => _AdvisorInvitesPageState();
}

class _AdvisorInvitesPageState extends ConsumerState<AdvisorInvitesPage> {
  List<Map<String, dynamic>>? _invites;
  String? _error;
  final _email = TextEditingController();
  int? _site;
  bool _sending = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  String get _token => ref.read(advisorProvider).session!.token;

  Future<void> _load() async {
    try {
      final r = await ref.read(apiProvider).aiInvites(_token);
      if (mounted) setState(() => _invites = [for (final x in (r['invites'] as List? ?? const [])) (x as Map).cast<String, dynamic>()]);
    } on TapApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _invite() async {
    final email = _email.text.trim();
    if (email.isEmpty) return;
    setState(() => _sending = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final r = await ref.read(apiProvider).aiInvite(_token, email: email, site: _site);
      _email.clear();
      if (r['code'] != null && mounted) {
        await showDialog<void>(
          context: context,
          builder: (c) => AlertDialog(
            icon: const Icon(Icons.mail_lock_rounded),
            title: const Text('Give them this code'),
            content: Column(mainAxisSize: MainAxisSize.min, children: [
              Text('${r['message']}'),
              const SizedBox(height: 12),
              SelectableText('${r['code']}', style: const TextStyle(fontSize: 26, letterSpacing: 4, fontWeight: FontWeight.w800)),
            ]),
            actions: [TextButton(onPressed: () => Navigator.pop(c), child: const Text('Done'))],
          ),
        );
      } else {
        messenger.showSnackBar(SnackBar(content: Text('${r['message']}')));
      }
      await _load();
    } on TapApiError catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _revoke(Map<String, dynamic> i) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text('Remove ${i['staff'] ?? i['email']}?'),
        content: const Text('They will no longer see the business\'s figures in Vesopa AI. This takes effect at once.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(style: FilledButton.styleFrom(backgroundColor: Tp.danger, foregroundColor: Colors.white), onPressed: () => Navigator.pop(c, true), child: const Text('Remove access')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await ref.read(apiProvider).aiRevoke(_token, (i['id'] as num).toInt());
      await _load();
    } on TapApiError catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final session = ref.watch(advisorProvider).session;
    return Scaffold(
      appBar: AppBar(title: const Text('Invite people to Vesopa AI')),
      body: session == null
          ? const SizedBox.shrink()
          : _Page(onRefresh: _load, children: [
              AiSection(title: 'Invite by email', subtitle: 'Managers always have access. Invite anyone else who should see the figures.', children: [
                TextField(
                  controller: _email,
                  keyboardType: TextInputType.emailAddress,
                  autofillHints: const [AutofillHints.email],
                  decoration: const InputDecoration(labelText: 'Their email address', prefixIcon: Icon(Icons.alternate_email_rounded)),
                  onSubmitted: (_) => _invite(),
                ),
                if (session.sites.isNotEmpty) ...[
                  const SizedBox(height: 12),
                  DropdownButtonFormField<int>(
                    initialValue: _site ?? -1,
                    decoration: const InputDecoration(labelText: 'What they may see', prefixIcon: Icon(Icons.storefront_rounded)),
                    items: [
                      const DropdownMenuItem(value: -1, child: Text('Every site')),
                      for (final s in session.sites) DropdownMenuItem(value: s.id, child: Text('${s.name} only')),
                    ],
                    onChanged: (v) => setState(() => _site = v == -1 ? null : v),
                  ),
                ],
                const SizedBox(height: 12),
                FilledButton.icon(
                  onPressed: _sending ? null : _invite,
                  icon: const Icon(Icons.send_rounded),
                  label: Text(_sending ? 'Sending…' : 'Send invite'),
                ),
                const SizedBox(height: 8),
                Text('They get a code by email. On Go they sign on with their own staff PIN, open Vesopa AI and type the code. It works once and expires in 14 days.', style: t.bodySmall?.copyWith(color: context.goMuted)),
              ]),
              const SizedBox(height: 12),
              AiSection(title: 'Invited', children: [
                if (_error != null) Text(_error!, style: TextStyle(color: Tp.danger)),
                if (_invites == null && _error == null) const Center(child: CircularProgressIndicator()),
                if (_invites != null && _invites!.isEmpty) Text('Nobody yet.', style: t.bodyMedium),
                for (final i in _invites ?? const <Map<String, dynamic>>[])
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: CircleAvatar(
                      backgroundColor: (i['status'] == 'active' ? Tp.green : context.goRaised).withValues(alpha: 0.25),
                      child: Icon(i['status'] == 'active' ? Icons.verified_rounded : Icons.schedule_rounded, color: i['status'] == 'active' ? Tp.green : context.goMuted),
                    ),
                    title: Text('${i['staff'] ?? i['email']}', overflow: TextOverflow.ellipsis),
                    subtitle: Text([
                      if (i['staff'] != null) '${i['email']}',
                      switch (i['status']) { 'active' => 'Has access', 'pending' => 'Invite sent, not used yet', 'expired' => 'Invite expired', _ => 'Removed' },
                      (i['site'] as Map?)?['name'] == null ? 'every site' : '${(i['site'] as Map)['name']} only',
                    ].join(' · ')),
                    trailing: i['status'] == 'active' || i['status'] == 'pending'
                        ? IconButton(tooltip: 'Remove access', icon: const Icon(Icons.person_remove_rounded), onPressed: () => _revoke(i))
                        : null,
                  ),
              ]),
            ]),
    );
  }
}
