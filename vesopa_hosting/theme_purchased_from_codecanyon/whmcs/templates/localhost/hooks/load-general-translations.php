<?php

use WHMCS\Config\Setting;

add_hook('ClientAreaPage', 1, function ($vars) {
    $themeBase = realpath(__DIR__ . '/../'); // templates/whmcs-starter/hooks/
    $langCode = strtolower(
        $_SESSION['Language'] ?? Setting::getValue('Language') ?? 'english'
    );
    $langPath = $themeBase . '/lang/override/';

    $langFile = $langPath . $langCode . '.php';
    if (!file_exists($langFile)) {
        $langFile = $langPath . 'english.php';
    }
    $translations = file_exists($langFile) ? include $langFile : [];

    $GLOBALS['smarty']->assign('generalLang', $translations);

    return [];
});
