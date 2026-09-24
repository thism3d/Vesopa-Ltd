<?php

use WHMCS\Config\Setting;

add_hook('ClientAreaPage', 1, function ($vars) {
    $themeBase = realpath(__DIR__ . '/../'); // templates/whmcs-starter/hooks/
    $configPath = $themeBase . '/includes/config/about.php';
    $langCode = strtolower(
        $_SESSION['Language'] ?? Setting::getValue('Language') ?? 'english'
    );
    $langPath = $themeBase . '/lang/override/';

    $aboutData = file_exists($configPath) ? include $configPath : [];

    $langFile = $langPath . $langCode . '.php';
    if (!file_exists($langFile)) {
        $langFile = $langPath . 'english.php';
    }
    $lang = file_exists($langFile) ? include $langFile : [];

    $translatedAbout = [];

    foreach ($aboutData as $section => $content) {
        $translated = [
            'img' => $content['img'] ?? '',
            'alt' => $lang[$content['alt']] ?? $content['alt'],
            'title' => $lang[$content['title']] ?? $content['title'],
            'subtitle' => $lang[$content['subtitle']] ?? $content['subtitle'],
            'description' => [],
            'features' => []
        ];

        if (!empty($content['description']) && is_array($content['description'])) {
            foreach ($content['description'] as $descKey => $descVal) {
                $translated['description'][$descKey] = $lang[$descVal] ?? $descVal;
            }
        }

        if (!empty($content['features']) && is_array($content['features'])) {
            foreach ($content['features'] as $featureKey => $featureVal) {
                $translated['features'][$featureKey] = [
                    'img' => $featureVal['img'] ?? '',
                    'alt' => $lang[$featureVal['alt']] ?? $featureVal['alt'],
                    'title' => $lang[$featureVal['title']] ?? $featureVal['title'],
                    'description' => $lang[$featureVal['description']] ?? $featureVal['description']
                ];
            }
        }

        $translatedAbout[$section] = $translated;
    }

    if (!empty($GLOBALS['smarty'])) {
        $GLOBALS['smarty']->assign('aboutContent', $translatedAbout);
    }

    return [];
});
