import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:image/image.dart' as img;

/// Framing the member's photo before it goes on their card.
///
/// THE PHOTO UNDER A ROUND WINDOW, as the till shows it: pinch (or scroll, or
/// the slider) to zoom, drag to move, double-tap to start again. Save gives a
/// square JPEG of what is inside the window, at most [PhotoCrop.outputSize]
/// across -- the till draws a circle in that square, so what they framed is
/// what the venue sees.
///
/// ALL FLUTTER. The crop is drawn by Flutter's own canvas and only the JPEG
/// encoding is a package (pure Dart), so it is the same on an iPhone, Android,
/// Windows and in a browser, with no native cropper to configure per platform.
///
/// Answers the JPEG, or null when they cancel.
class PhotoCropPage extends StatefulWidget {
  const PhotoCropPage({super.key, required this.bytes});

  final Uint8List bytes;

  /// Push the crop screen over everything and wait for the answer.
  static Future<Uint8List?> open(BuildContext context, Uint8List bytes) => Navigator.of(context).push<Uint8List>(
    MaterialPageRoute(fullscreenDialog: true, builder: (_) => PhotoCropPage(bytes: bytes)),
  );

  @override
  State<PhotoCropPage> createState() => _PhotoCropPageState();
}

class _PhotoCropPageState extends State<PhotoCropPage> {
  ui.Image? _image;
  var _failed = false;
  var _saving = false;
  PhotoCrop _crop = const PhotoCrop.none();

  // Where a gesture started, so a pinch keeps the same spot under the fingers.
  PhotoCrop? _startCrop;
  Offset _startFocal = Offset.zero;
  double _window = 0;
  Offset _windowCentre = Offset.zero;

  @override
  void initState() {
    super.initState();
    _decode();
  }

  @override
  void dispose() {
    _image?.dispose();
    super.dispose();
  }

  Future<void> _decode() async {
    try {
      final codec = await ui.instantiateImageCodec(widget.bytes);
      final frame = await codec.getNextFrame();
      codec.dispose();
      if (!mounted) {
        frame.image.dispose();
        return;
      }
      setState(() {
        _image = frame.image;
        _crop = PhotoCrop.centred(Size(frame.image.width.toDouble(), frame.image.height.toDouble()));
      });
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  Size get _imageSize => Size(_image!.width.toDouble(), _image!.height.toDouble());

  void _onScaleStart(ScaleStartDetails d) {
    _startCrop = _crop;
    _startFocal = d.localFocalPoint;
  }

  void _onScaleUpdate(ScaleUpdateDetails d) {
    final start = _startCrop;
    if (start == null || _image == null) return;
    setState(() {
      _crop = start.moved(
        image: _imageSize,
        window: _window,
        windowCentre: _windowCentre,
        from: _startFocal,
        to: d.localFocalPoint,
        scaleBy: d.scale,
      );
    });
  }

  /// A mouse wheel or a trackpad scroll zooms about the pointer, on Windows
  /// and in a browser where there is nothing to pinch.
  void _onPointerSignal(PointerSignalEvent e) {
    if (e is! PointerScrollEvent || _image == null) return;
    final by = math.pow(0.998, e.scrollDelta.dy).toDouble();
    setState(() {
      _crop = _crop.moved(
        image: _imageSize,
        window: _window,
        windowCentre: _windowCentre,
        from: e.localPosition,
        to: e.localPosition,
        scaleBy: by,
      );
    });
  }

  void _reset() {
    if (_image == null) return;
    setState(() => _crop = PhotoCrop.centred(_imageSize));
  }

  Future<void> _save() async {
    final image = _image;
    if (image == null || _saving) return;
    setState(() => _saving = true);
    try {
      final jpeg = await PhotoCrop.render(image, _crop.source(_imageSize));
      if (mounted) Navigator.of(context).pop(jpeg);
    } catch (_) {
      if (!mounted) return;
      setState(() => _saving = false);
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        const SnackBar(content: Text('That photo could not be saved. Please try another.'), behavior: SnackBarBehavior.floating),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final image = _image;
    return Theme(
      // Always dark, whatever the app: a photo is judged against black, as
      // every camera and photo app on the device shows it.
      data: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: Colors.white, brightness: Brightness.dark), useMaterial3: true),
      child: Scaffold(
        backgroundColor: Colors.black,
        appBar: AppBar(
          backgroundColor: Colors.black,
          foregroundColor: Colors.white,
          title: const Text('Move and scale'),
          leading: IconButton(
            tooltip: 'Cancel',
            icon: const Icon(Icons.close),
            onPressed: _saving ? null : () => Navigator.of(context).pop(),
          ),
          actions: [
            if (image != null)
              IconButton(tooltip: 'Start again', icon: const Icon(Icons.restart_alt), onPressed: _saving ? null : _reset),
          ],
        ),
        body: SafeArea(
          child: Column(
            children: [
              Expanded(
                child: _failed
                    ? const Center(
                        child: Padding(
                          padding: EdgeInsets.all(28),
                          child: Text(
                            'That photo could not be opened. Please try another.',
                            textAlign: TextAlign.center,
                            style: TextStyle(color: Colors.white),
                          ),
                        ),
                      )
                    : image == null
                        ? const Center(child: CircularProgressIndicator.adaptive())
                        : LayoutBuilder(builder: (context, box) => _cropArea(image, box.biggest)),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 0),
                child: Text(
                  'Pinch to zoom, drag to move. Double-tap to start again.',
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Colors.white70),
                ),
              ),
              if (image != null)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  child: Row(
                    children: [
                      const Icon(Icons.zoom_out, color: Colors.white70),
                      Expanded(
                        child: Slider(
                          value: math.log(_crop.zoom) / math.log(PhotoCrop.maxZoom),
                          label: 'Zoom',
                          onChanged: _saving
                              ? null
                              : (v) => setState(() => _crop = _crop.zoomedTo(math.pow(PhotoCrop.maxZoom, v).toDouble(), _imageSize)),
                        ),
                      ),
                      const Icon(Icons.zoom_in, color: Colors.white70),
                    ],
                  ),
                ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
                child: Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        style: OutlinedButton.styleFrom(foregroundColor: Colors.white, minimumSize: const Size(0, 50)),
                        onPressed: _saving ? null : () => Navigator.of(context).pop(),
                        child: const Text('Cancel'),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: FilledButton(
                        style: FilledButton.styleFrom(
                          backgroundColor: Colors.white,
                          foregroundColor: Colors.black,
                          minimumSize: const Size(0, 50),
                        ),
                        onPressed: image == null || _saving ? null : _save,
                        child: Text(_saving ? 'Saving…' : 'Save'),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _cropArea(ui.Image image, Size area) {
    // The window: as big as fits with a margin, and never silly on a desktop.
    _window = math.max(80.0, math.min(math.min(area.width, area.height) - 48, 420.0));
    _windowCentre = area.center(Offset.zero);
    final scale = _crop.scale(_imageSize, _window);
    final topLeft = _windowCentre - _crop.centre * scale;
    return Listener(
      onPointerSignal: _onPointerSignal,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onScaleStart: _saving ? null : _onScaleStart,
        onScaleUpdate: _saving ? null : _onScaleUpdate,
        onDoubleTap: _saving ? null : _reset,
        child: Semantics(
          label: 'Your photo. Pinch to zoom and drag to move it inside the circle.',
          image: true,
          child: ClipRect(
            child: CustomPaint(
              size: area,
              painter: _CropPainter(
                image: image,
                rect: topLeft & (_imageSize * scale),
                window: Rect.fromCircle(center: _windowCentre, radius: _window / 2),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The photo where it is, the world outside the circle dimmed, and the
/// circle's edge.
class _CropPainter extends CustomPainter {
  _CropPainter({required this.image, required this.rect, required this.window});

  final ui.Image image;
  final Rect rect;
  final Rect window;

  @override
  void paint(Canvas canvas, Size size) {
    final src = Rect.fromLTWH(0, 0, image.width.toDouble(), image.height.toDouble());
    canvas.drawImageRect(image, src, rect, Paint()..filterQuality = FilterQuality.medium);
    final outside = Path()
      ..fillType = PathFillType.evenOdd
      ..addRect(Offset.zero & size)
      ..addOval(window);
    canvas.drawPath(outside, Paint()..color = Colors.black.withValues(alpha: 0.62));
    canvas.drawOval(
      window,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2
        ..color = Colors.white.withValues(alpha: 0.9),
    );
  }

  @override
  bool shouldRepaint(_CropPainter old) => old.image != image || old.rect != rect || old.window != window;
}

/// Where the photo sits under the window, as two numbers that do not care
/// how big the screen is: how far in it is zoomed, and which point of the
/// photo is in the middle of the window.
///
/// KEPT IN THE PHOTO'S OWN PIXELS so turning a tablet round, or resizing a
/// window on a desk, keeps the same framing rather than jumping. Zoom 1 is
/// the photo's short side exactly filling the window; the window is never
/// allowed to show anything that is not photo.
@immutable
class PhotoCrop {
  const PhotoCrop({required this.zoom, required this.centre});

  const PhotoCrop.none() : zoom = 1, centre = Offset.zero;

  /// Zoom 1, in the middle of the photo.
  PhotoCrop.centred(Size image) : zoom = 1, centre = image.center(Offset.zero);

  /// As far in as it goes: a sixth of the short side across the window is
  /// already only a face's worth of pixels on a phone's photo.
  static const maxZoom = 6.0;

  /// The size of the square that goes to the server, at most.
  static const outputSize = 1024;

  final double zoom;
  final Offset centre;

  /// Screen pixels per photo pixel for a [window] this wide.
  double scale(Size image, double window) => window / image.shortestSide * zoom;

  /// The square of the photo inside the window, in the photo's pixels.
  Rect source(Size image) {
    final side = image.shortestSide / zoom;
    return Rect.fromCenter(center: centre, width: side, height: side);
  }

  /// [centre] pulled back so the window stays wholly on the photo.
  static Offset clampCentre(Offset c, Size image, double zoom) {
    final half = image.shortestSide / zoom / 2;
    return Offset(
      c.dx.clamp(half, math.max(half, image.width - half)),
      c.dy.clamp(half, math.max(half, image.height - half)),
    );
  }

  /// Zoomed to [z] about the window's middle.
  PhotoCrop zoomedTo(double z, Size image) {
    final zoom = z.clamp(1.0, maxZoom);
    return PhotoCrop(zoom: zoom, centre: clampCentre(centre, image, zoom));
  }

  /// After a gesture that began with a finger (or the middle of two) at
  /// [from] and is now at [to], having pinched by [scaleBy]: the point of
  /// the photo that was under [from] is under [to], unless that would show
  /// something outside the photo.
  PhotoCrop moved({
    required Size image,
    required double window,
    required Offset windowCentre,
    required Offset from,
    required Offset to,
    double scaleBy = 1,
  }) {
    final before = scale(image, window);
    final under = centre + (from - windowCentre) / before;
    final zoom = (this.zoom * scaleBy).clamp(1.0, maxZoom);
    final after = window / image.shortestSide * zoom;
    final c = under - (to - windowCentre) / after;
    return PhotoCrop(zoom: zoom, centre: clampCentre(c, image, zoom));
  }

  /// The JPEG of [source] from [image]: drawn square by Flutter, then
  /// encoded. Never bigger than the part of the photo it came from, since
  /// enlarging a small crop only makes a bigger file of the same blur.
  static Future<Uint8List> render(ui.Image image, Rect source) async {
    final side = outputSide(source.width);
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder);
    final out = Rect.fromLTWH(0, 0, side.toDouble(), side.toDouble());
    canvas.drawRect(out, Paint()..color = Colors.white);
    canvas.drawImageRect(image, source, out, Paint()..filterQuality = FilterQuality.high);
    final picture = recorder.endRecording();
    final cropped = await picture.toImage(side, side);
    picture.dispose();
    try {
      final data = await cropped.toByteData(format: ui.ImageByteFormat.rawRgba);
      if (data == null) throw StateError('no pixels');
      final rgba = data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
      // Off the main thread where there is one to go to; a browser has
      // only the one, and a 1024 square takes it well under a second.
      return kIsWeb ? encodeJpeg(rgba, side) : await compute(_encode, (rgba, side));
    } finally {
      cropped.dispose();
    }
  }

  /// How many pixels across the saved photo is, from the crop's size in the
  /// original: never more than [outputSize], never less than 256.
  static int outputSide(double sourceSide) => sourceSide.round().clamp(256, outputSize);

  /// A square of RGBA pixels as a JPEG.
  static Uint8List encodeJpeg(Uint8List rgba, int side) => img.encodeJpg(
    img.Image.fromBytes(width: side, height: side, bytes: rgba.buffer, bytesOffset: rgba.offsetInBytes, numChannels: 4),
    quality: 88,
  );

  @override
  bool operator ==(Object other) => other is PhotoCrop && other.zoom == zoom && other.centre == centre;

  @override
  int get hashCode => Object.hash(zoom, centre);
}

Uint8List _encode((Uint8List, int) job) => PhotoCrop.encodeJpeg(job.$1, job.$2);
