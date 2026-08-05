<?php

use WHMCS\Database\Capsule;

add_hook('ClientAreaPageHome', 1, function ($vars) {
    $themeBase = realpath(__DIR__ . '/../');

    $featureConfigPath = $themeBase . '/includes/config/product-features.php';
    $langCode = strtolower($vars['_language'] ?? 'english');
    $langFile = $themeBase . '/lang/override/' . $langCode . '.php';

    $featureConfig = file_exists($featureConfigPath) ? include $featureConfigPath : [];
    $lang = file_exists($langFile) ? include $langFile : [];

    $groups = Capsule::table('tblproductgroups')->get();
    if ($groups->isEmpty()) {
        return [];
    }

    $currencyId = $vars['clientsdetails']['currency'] ?? Capsule::table('tblcurrencies')->where('default', 1)->value('id');

    function getRecurringPriceFormatted($productId, $currencyId)
    {
        $pricing = Capsule::table('tblpricing')
            ->where('type', 'product')
            ->where('relid', $productId)
            ->where('currency', $currencyId)
            ->first();

        if (!$pricing) {
            return '$0.00/mo';
        }

        $cycles = [
            'monthly' => $pricing->monthly,
            'quarterly' => $pricing->quarterly,
            'semiannually' => $pricing->semiannually,
            'annually' => $pricing->annually,
            'biennially' => $pricing->biennially,
            'triennially' => $pricing->triennially,
        ];

        foreach ($cycles as $cycle => $amount) {
            if ($amount >= 0) {
                $suffix = [
                    'monthly' => '<span class="d-inline-block fs-14 fw-normal">/mo</span>',
                    'quarterly' => '/3mo',
                    'semiannually' => '/6mo',
                    'annually' => '/yr',
                    'biennially' => '/2yr',
                    'triennially' => '/3yr',
                ];
                return formatCurrency($amount) . ($suffix[$cycle] ?? '');
            }
        }

        return '$0.00/mo';
    }

    $pricingCards = [];

    foreach ($groups as $group) {
        $products = Capsule::table('tblproducts')
            ->where('gid', $group->id)
            ->where('hidden', 0)
            ->get();

        $productCards = [];

        foreach ($products as $product) {
            $productName = $product->name ?? '';

            $features = [];
            if ($productName && !empty($featureConfig[$productName]['features']) && is_array($featureConfig[$productName]['features'])) {
                foreach ($featureConfig[$productName]['features'] as $langKey) {
                    $features[] = $lang[$langKey] ?? $langKey;
                }
            }

            $productCards[] = [
                'id' => $product->id,
                'name' => $productName,
                'tagline' => $product->tagline,
                'description' => $product->description,
                'price' => getRecurringPriceFormatted($product->id, $currencyId),
                'cartUrl' => 'cart.php?a=add&pid=' . $product->id,
                'features' => $features,
                'details' => $products
            ];
        }

        if (!empty($productCards)) {
            $pricingCards[] = [
                'groupName' => $group->name,
                'groupId' => $group->id,
                'products' => $productCards,
            ];
        }
    }


    $GLOBALS['smarty']->assign('allPricingGroups', $pricingCards);

    return [];
});
