<?php

add_hook('ClientAreaPageHome', 1, function($vars) {
    // Load testimonial config
    $testimonials = include __DIR__ . '/../includes/config/testimonials.php';

    // Get current language (e.g., "english")
    $language = strtolower($vars['language']);
    $langFile = __DIR__ . "/../lang/override/{$language}.php";

    // Fallback to English if file doesn't exist
    if (!file_exists($langFile)) {
        $langFile = __DIR__ . '/../lang/override/english.php';
    }

    // Load $_LANG
    global $_LANG;
    $_LANG = include $langFile;

    // Translate quote keys
    foreach ($testimonials as &$testimonial) {
        $key = $testimonial['quote'];
        $testimonial['quote'] = $_LANG[$key] ?? $key;
    }

    return [
        'testimonialsSwiper' => $testimonials,
    ];
});
