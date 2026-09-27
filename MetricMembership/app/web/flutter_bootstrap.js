{{flutter_js}}
{{flutter_build_config}}

// Our own start-up, so the splash's progress bar (splash.js) follows each
// step: app code loaded, engine ready, first frame drawn. No service worker:
// Flutter's is deprecated, and the server already says what may be cached.
(function () {
  var splash = window.MetricSplash || { step: function () {} };
  splash.step('bootstrap');
  _flutter.loader.load({
    onEntrypointLoaded: async function (engineInitializer) {
      splash.step('code');
      var appRunner = await engineInitializer.initializeEngine();
      splash.step('engine');
      await appRunner.runApp();
    },
  });
})();
