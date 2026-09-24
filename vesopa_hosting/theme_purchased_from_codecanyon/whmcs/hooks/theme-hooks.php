<?php

$themeName = 'localhost'; // Could be read from config or env variable

$themeHooksDir = realpath(__DIR__ . "/../../templates/{$themeName}/hooks/");

if ($themeHooksDir && is_dir($themeHooksDir)) {
    foreach (glob($themeHooksDir . '/*.php') as $hookFile) {
        include_once $hookFile;
    }
}
