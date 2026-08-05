<?php

use WHMCS\Config\Setting;

add_hook('ClientAreaPage', 0, function () {
    $lang = strtolower(
        $_SESSION['Language'] ?? Setting::getValue('Language') ?? 'english'
    );

    $file = __DIR__ . "/../lang/override/{$lang}.php";
    if (!file_exists($file)) return [];

    $dotLang = include $file;
    if (!is_array($dotLang)) return [];

    // Flatten dot notation to $_LANG['...']['...']
    foreach ($dotLang as $key => $value) {
        $parts = explode('.', $key);
        $ref = &$_LANG;
        foreach ($parts as $part) {
            if (!isset($ref[$part]) || !is_array($ref[$part])) {
                $ref[$part] = [];
            }
            $ref = &$ref[$part];
        }
        $ref = $value;
    }

    return [];
});
