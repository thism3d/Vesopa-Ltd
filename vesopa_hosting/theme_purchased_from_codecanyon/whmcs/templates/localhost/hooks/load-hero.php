<?php

use WHMCS\Config\Setting;

add_hook('ClientAreaPage', 1, function ($vars) {
    $themeBase = __DIR__ . '/../'; // templates/whmcs-starter/
    $heroConfigPath = realpath($themeBase . 'includes/config/hero.php');
    $langCode = strtolower(
        $_SESSION['Language'] ?? Setting::getValue('Language') ?? 'english'
    );
    $langPath = $themeBase . 'lang/override/';

    // Load hero card config
    $cards = [];
    if (file_exists($heroConfigPath)) {
        $heroConfig = include $heroConfigPath;
        $titleKey = $heroConfig['title_key'] ?? 'hero.title';
        $text1Key = $heroConfig['text_1'] ?? 'hero.text1';
        $text2Key = $heroConfig['text_2'] ?? 'hero.text2';
        $text3Key = $heroConfig['text_3'] ?? 'hero.text3';
        $cards = $heroConfig['cards'] ?? [];
        $button = $heroConfig['button'] ?? [];
    }

    // Load translation
    $langFile = $langPath . $langCode . '.php';
    if (!file_exists($langFile)) {
        $langFile = $langPath . 'english.php'; // fallback
    }
    $lang = file_exists($langFile) ? include $langFile : [];

    // Merge translations with config
    foreach ($cards as $key => &$card) {
        $card['title'] = $lang["hero.cards.$key.title"] ?? 'Hosting Service';
    }

    // Assign to Smarty
    if (!empty($GLOBALS['smarty'])) {
        $GLOBALS['smarty']->assign('heroTitle', $lang[$titleKey] ?? '');
        $GLOBALS['smarty']->assign('heroText1', $lang[$text1Key] ?? '');
        $GLOBALS['smarty']->assign('heroText2', $lang[$text2Key] ?? '');
        $GLOBALS['smarty']->assign('heroText3', $lang[$text3Key] ?? '');
        $GLOBALS['smarty']->assign('heroCards', $cards);
        $GLOBALS['smarty']->assign('heroButtonLabel', $lang[$button['label_key']] ?? '');
        $GLOBALS['smarty']->assign('heroButtonUrl', $button['url'] ?? '#');
    }

    return [];
});
