/// Adverts kept on this device.
///
/// The owner, 2026-11-16: "add folder and files permission with media view and
/// video view in Vesopa Go so that adverts can be played from the file
/// manager." A customer display can play pictures and films chosen from the
/// device's own files and photos, as well as (or instead of) the venue's
/// adverts from the back office. Useful for a TV by the door showing tonight's
/// match poster, or a screen with a slow connection.
///
/// Chosen through the system's own picker, so Go asks for no storage
/// permission at all: the person picks, and only what they picked is copied
/// into Go's own folder. The copies are Go's, so an advert keeps playing after
/// the original is deleted or the memory stick is pulled out.
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:video_player/video_player.dart';

import '../../ui/theme.dart';

@immutable
class LocalAdvert {
  const LocalAdvert({required this.path, required this.video, this.seconds = 10, this.name = ''});
  final String path;
  final bool video;
  final int seconds;
  final String name;

  Map<String, dynamic> toJson() => {'path': path, 'video': video, 'seconds': seconds, 'name': name};

  static LocalAdvert? fromJson(Object? j) {
    if (j is! Map || j['path'] is! String) return null;
    return LocalAdvert(
      path: j['path'] as String,
      video: j['video'] == true,
      seconds: (j['seconds'] as num?)?.toInt() ?? 10,
      name: '${j['name'] ?? ''}',
    );
  }

  LocalAdvert copyWith({int? seconds}) => LocalAdvert(path: path, video: video, seconds: seconds ?? this.seconds, name: name);
}

/// Whether a file is a film, by its ending.
bool isFilmFile(String name) {
  final ext = name.contains('.') ? name.split('.').last.toLowerCase() : '';
  return const {'mp4', 'mov', 'm4v', 'webm', 'mkv', '3gp', 'avi'}.contains(ext);
}

class LocalAdverts {
  static const _listKey = 'display.local_adverts';
  static const _onlyKey = 'display.local_adverts_only';

  /// The device's adverts, in playing order. Ones whose file has gone are
  /// dropped, so a cleared cache never leaves a black slide.
  static Future<List<LocalAdvert>> load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = jsonDecode(prefs.getString(_listKey) ?? '[]');
      return [
        for (final j in raw as List)
          if (LocalAdvert.fromJson(j) case final a? when File(a.path).existsSync()) a,
      ];
    } catch (_) {
      return const [];
    }
  }

  static Future<void> save(List<LocalAdvert> list) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_listKey, jsonEncode([for (final a in list) a.toJson()]));
  }

  /// Play only this device's adverts, not the venue's.
  static Future<bool> only() async {
    try {
      return (await SharedPreferences.getInstance()).getBool(_onlyKey) ?? false;
    } catch (_) {
      return false;
    }
  }

  static Future<void> setOnly(bool value) async => (await SharedPreferences.getInstance()).setBool(_onlyKey, value);

  static Future<Directory> _folder() async {
    final base = await getApplicationSupportDirectory();
    final dir = Directory('${base.path}${Platform.pathSeparator}adverts');
    if (!dir.existsSync()) dir.createSync(recursive: true);
    return dir;
  }

  /// Ask the person to choose pictures and films, and keep copies.
  static Future<List<LocalAdvert>> pick() async {
    final chosen = await ImagePicker().pickMultipleMedia();
    if (chosen.isEmpty) return const [];
    final dir = await _folder();
    final added = <LocalAdvert>[];
    for (final file in chosen) {
      final name = file.name;
      final ext = name.contains('.') ? name.split('.').last.toLowerCase() : 'bin';
      final target = '${dir.path}${Platform.pathSeparator}${DateTime.now().microsecondsSinceEpoch}-${added.length}.$ext';
      await File(file.path).copy(target);
      added.add(LocalAdvert(path: target, video: isFilmFile(name), name: name));
    }
    return added;
  }

  static Future<void> remove(LocalAdvert advert) async {
    try {
      await File(advert.path).delete();
    } catch (_) {
      // Already gone: the list entry was what mattered.
    }
  }
}

/// Settings: the adverts on this device, to add, preview, reorder and remove.
class LocalAdvertsPage extends StatefulWidget {
  const LocalAdvertsPage({super.key});

  @override
  State<LocalAdvertsPage> createState() => _LocalAdvertsPageState();
}

class _LocalAdvertsPageState extends State<LocalAdvertsPage> {
  List<LocalAdvert> _list = const [];
  bool _only = false;
  bool _busy = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final list = await LocalAdverts.load();
    final only = await LocalAdverts.only();
    if (mounted) {
      setState(() {
        _list = list;
        _only = only;
        _busy = false;
      });
    }
  }

  Future<void> _keep(List<LocalAdvert> next) async {
    setState(() => _list = next);
    await LocalAdverts.save(next);
  }

  Future<void> _add() async {
    setState(() => _busy = true);
    try {
      final added = await LocalAdverts.pick();
      if (added.isNotEmpty) await _keep([..._list, ...added]);
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Could not open the files ($e).')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _remove(LocalAdvert advert) async {
    await LocalAdverts.remove(advert);
    await _keep([for (final a in _list) if (a.path != advert.path) a]);
  }

  void _preview(LocalAdvert advert) => showDialog<void>(
        context: context,
        builder: (c) => Dialog.fullscreen(
          backgroundColor: Colors.black,
          child: Stack(children: [
            Positioned.fill(child: advert.video ? _FilmPreview(path: advert.path) : InteractiveViewer(child: Center(child: Image.file(File(advert.path), fit: BoxFit.contain)))),
            SafeArea(
              child: Align(
                alignment: Alignment.topRight,
                child: Padding(
                  padding: const EdgeInsets.all(8),
                  child: IconButton.filledTonal(autofocus: true, tooltip: 'Close', onPressed: () => Navigator.pop(c), icon: const Icon(Icons.close_rounded)),
                ),
              ),
            ),
          ]),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Adverts on this device')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _busy ? null : _add,
        icon: const Icon(Icons.add_photo_alternate_rounded),
        label: const Text('Add pictures or films'),
      ),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 12, 16, 104), children: [
        Text(
          'Pictures and films from this device\'s files and photos, played between sales. '
          'They are copied into Vesopa Go, so they keep playing if the original is deleted.',
          style: t.bodyLarge?.copyWith(color: context.goMuted, height: 1.4),
        ),
        const SizedBox(height: 8),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Play only these'),
          subtitle: Text(_only ? 'The venue\'s adverts from the back office are left out on this screen.' : 'These play after the venue\'s adverts from the back office.'),
          value: _only,
          onChanged: (v) async {
            setState(() => _only = v);
            await LocalAdverts.setOnly(v);
          },
        ),
        const SizedBox(height: 8),
        if (_busy) const LinearProgressIndicator(),
        if (_list.isEmpty && !_busy)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 40),
            child: Column(children: [
              Icon(Icons.perm_media_outlined, size: 56, color: context.goMuted),
              const SizedBox(height: 12),
              Text('Nothing from this device yet', style: t.titleMedium),
            ]),
          ),
        for (final (i, a) in _list.indexed)
          Card(
            child: Padding(
              padding: const EdgeInsets.all(10),
              child: Row(children: [
                InkWell(
                  borderRadius: BorderRadius.circular(10),
                  onTap: () => _preview(a),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(10),
                    child: SizedBox(
                      width: 112,
                      height: 63,
                      child: a.video
                          ? const ColoredBox(color: Colors.black, child: Icon(Icons.play_circle_fill_rounded, color: Colors.white, size: 34))
                          : Image.file(File(a.path), fit: BoxFit.cover, cacheWidth: 336, errorBuilder: (_, _, _) => const ColoredBox(color: Colors.black26)),
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(a.name.isEmpty ? (a.video ? 'Film' : 'Picture') : a.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700)),
                    if (a.video)
                      Text('Film, played to its end', style: t.bodySmall)
                    else
                      Row(children: [
                        Text('Shown for ${a.seconds} s', style: t.bodySmall),
                        IconButton(
                          tooltip: 'Shorter',
                          visualDensity: VisualDensity.compact,
                          onPressed: a.seconds <= 5 ? null : () => _keep([for (final x in _list) x.path == a.path ? x.copyWith(seconds: x.seconds - 5) : x]),
                          icon: const Icon(Icons.remove_circle_outline_rounded),
                        ),
                        IconButton(
                          tooltip: 'Longer',
                          visualDensity: VisualDensity.compact,
                          onPressed: a.seconds >= 120 ? null : () => _keep([for (final x in _list) x.path == a.path ? x.copyWith(seconds: x.seconds + 5) : x]),
                          icon: const Icon(Icons.add_circle_outline_rounded),
                        ),
                      ]),
                  ]),
                ),
                IconButton(
                  tooltip: 'Earlier',
                  onPressed: i == 0
                      ? null
                      : () {
                          final next = [..._list];
                          next.insert(i - 1, next.removeAt(i));
                          _keep(next);
                        },
                  icon: const Icon(Icons.arrow_upward_rounded),
                ),
                IconButton(tooltip: 'Remove', onPressed: () => _remove(a), icon: const Icon(Icons.delete_outline_rounded)),
              ]),
            ),
          ),
      ]),
    );
  }
}

class _FilmPreview extends StatefulWidget {
  const _FilmPreview({required this.path});
  final String path;

  @override
  State<_FilmPreview> createState() => _FilmPreviewState();
}

class _FilmPreviewState extends State<_FilmPreview> {
  late final VideoPlayerController _film = VideoPlayerController.file(File(widget.path));
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _film.initialize().then((_) {
      if (!mounted) return;
      _film
        ..setLooping(true)
        ..play();
      setState(() {});
    }, onError: (Object _) {
      if (mounted) setState(() => _failed = true);
    });
  }

  @override
  void dispose() {
    _film.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_failed) return const Center(child: Text('This film cannot be played on this device.', style: TextStyle(color: Colors.white70)));
    if (!_film.value.isInitialized) return const Center(child: CircularProgressIndicator());
    return Center(child: AspectRatio(aspectRatio: _film.value.aspectRatio, child: VideoPlayer(_film)));
  }
}
