// Take the splash away once Flutter has drawn its first frame.
window.addEventListener('flutter-first-frame', function () {
  var s = document.getElementById('splash');
  if (s) s.remove();
});
