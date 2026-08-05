<div class="hero-3 section-space-md-bottom position-relative z-1 overflow-hidden">
    <div class="section-space-sm-bottom">
        <div class="container">
            <div class="row justify-content-center g-4">
                <div class="col-md-10 col-xxl-9">
                    <h1 class="mb-0 text-center">
                        {$heroTitle}
                    </h1>
                </div>
            </div>
        </div>
    </div>
    <div class="section-space-md-bottom d-none d-xl-block">
        <div class="container">
            <div class="row">
                <div class="col-12">
                    <ul class="list list-row justify-content-center circular-card-list mx-auto">
                        {foreach $heroCards as $card}
                            <li
                                class="circular-card-list__item transition border border-secondary border-opacity-30 rounded-4 shadow bg-body">
                                <a href="{$card.url}"
                                    class="link circular-card d-flex flex-column justify-content-between p-6 h-100 position-relative group">
                                    <span
                                        class="circular-card__icon w-12 h-12 rounded-circle d-flex align-items-center justify-content-center">
                                        <iconify-icon icon="{$card.icon}"
                                            class="fs-24 text-heading group-hover:text-secondary transition"></iconify-icon>
                                    </span>
                                    <span
                                        class="d-block text-heading fw-bold fs-18 group-hover:text-secondary transition text-decoration-none">
                                        {$card.title}
                                    </span>
                                </a>
                            </li>
                        {/foreach}
                    </ul>
                </div>
            </div>
        </div>
    </div>
    <div class="container">
        <div class="row">
            <div class="col-12">
                <div class="text-center">
                    <a href="{$heroButtonUrl}" class="btn btn-primary">{$heroButtonLabel}</a>
                </div>
            </div>
        </div>
    </div>
    <div class="section-space-md-y">
        <div class="container">
            <div class="row">
                <div class="col-12">
                    <div class="d-block text-center">
                        {$heroText1}
                        <span class="d-inline fs-20 fw-bold text-heading">
                            {$heroText2}
                        </span>
                        <ul class="list list-row gap-1 d-inline-flex mx-3">
                            <li>
                                <div
                                    class="d-flex align-items-center justify-content-center w-6 h-6 bg-success text-light">
                                    <iconify-icon icon="material-symbols:star"></iconify-icon>
                                </div>
                            </li>
                            <li>
                                <div
                                    class="d-flex align-items-center justify-content-center w-6 h-6 bg-success text-light">
                                    <iconify-icon icon="material-symbols:star"></iconify-icon>
                                </div>
                            </li>
                            <li>
                                <div
                                    class="d-flex align-items-center justify-content-center w-6 h-6 bg-success text-light">
                                    <iconify-icon icon="material-symbols:star"></iconify-icon>
                                </div>
                            </li>
                            <li>
                                <div
                                    class="d-flex align-items-center justify-content-center w-6 h-6 bg-success text-light">
                                    <iconify-icon icon="material-symbols:star"></iconify-icon>
                                </div>
                            </li>
                            <li>
                                <div
                                    class="d-flex align-items-center justify-content-center w-6 h-6 bg-success text-light">
                                    <iconify-icon icon="material-symbols:star"></iconify-icon>
                                </div>
                            </li>
                        </ul>
                        {$heroText3}
                        <img src="{$WEB_ROOT}/templates/{$template}/assets/img/brand-logo-1.png" alt="image"
                            class="img-fluid">
                    </div>
                </div>
            </div>
        </div>
    </div>
    {if $registerdomainenabled || $transferdomainenabled}
        <form method="post" action="domainchecker.php" id="frmDomainHomepage">
            <div class="container-fluid container-fhd position-relative z-1">
                <div class="container">
                    <div class="row justify-content-center">
                        <div class="col-lg-10 col-xl-8">
                            <div class="section-space-md-y px-4 px-md-6 px-lg-12 bg-body rounded-3 text-center">
                                <div class="section-space-xsm-bottom">
                                    <h5 class="mb-0">{lang key="secureYourDomainShort"}</h5>
                                </div>
                                <input type="hidden" name="transfer" />
                                <div
                                    class="search-filter search-filter--light border border-secondary border-opacity-60 rounded-1">
                                    <input type="text"
                                        class="form-control search-filter__input placeholder::text-body-secondary"
                                        name="domain" placeholder="{lang key="exampledomain"}" autocapitalize="none">
                                    {if $registerdomainenabled}
                                        <button type="submit"
                                            class="btn btn-primary align-items-center flex-shrink-0 fs-14 {$captcha->getButtonClass($captchaForm)}"
                                            id="btnDomainSearch">
                                            <iconify-icon icon="iconamoon:search-duotone" class="align-middle flex-shrink-0">
                                            </iconify-icon>
                                            <span class="d-none d-sm-block">
                                                {lang key="search"}
                                            </span>
                                        </button>
                                    {/if}
                                    {if $transferdomainenabled}
                                        <button type="submit" id="btnTransfer" data-domain-action="transfer"
                                            class="btn btn-success align-items-center flex-shrink-0 fs-14 ms-2 {$captcha->getButtonClass($captchaForm)}">
                                            <iconify-icon icon="tabler:transfer" class="align-middle flex-shrink-0">
                                            </iconify-icon>
                                            <span class="d-none d-sm-block">
                                                {lang key="domainstransfer"}
                                            </span>
                                        </button>
                                    {/if}
                                </div>
                                {include file="$template/includes/captcha.tpl"}
                                {if $featuredTlds}
                                    <ul class="list list-row justify-content-center flex-wrap gap-3 align-items-center mt-6">
                                        {foreach $featuredTlds as $num => $tldinfo}
                                            {if $num < 3}
                                                <li>
                                                    <button type="button" class="btn btn-sm btn-light align-items-center gap-3">
                                                        <img src="{$BASE_PATH_IMG}/tld_logos/{$tldinfo.tldNoDots}.png">
                                                        <span class="d-inline-block fs-12 fw-normal">
                                                            {if is_object($tldinfo.register)}
                                                                {$tldinfo.register->toFull()}
                                                            {else}
                                                                {lang key="domainregnotavailable"}
                                                            {/if}
                                                        </span>
                                                    </button>
                                                </li>
                                            {/if}
                                        {/foreach}
                                    </ul>
                                {/if}
                                <div class="text-end mt-4">
                                    <a href="{routePath('domain-pricing')}"
                                        class="btn btn-sm text-primary-emphasis hover:bg-primary-subtle text-decoration-none fs-12">
                                        {lang key='viewAllPricing'}
                                    </a>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <img src="{$WEB_ROOT}/templates/{$template}/assets/img/hero-2-img-2.png" alt="image"
                    class="img-fluid position-absolute start-0 bottom-10 z-n1 d-none d-xl-block">
                <img src="{$WEB_ROOT}/templates/{$template}/assets/img/hero-2-img-3.png" alt="image"
                    class="img-fluid position-absolute end-0 bottom-10 z-n1 d-none d-xl-block">
            </div>
        </form>
    {/if}
    <svg xmlns="http://www.w3.org/2000/svg" width="786" height="640" viewBox="0 0 786 640" fill="none"
        class="position-absolute top-0 start-50 pointer-none z-n1 translate-middle-x">
        <g filter="url(#filter0_f_12037_21162)">
            <path
                d="M635.584 -55C634.808 -54.5509 629.729 -51.8358 621.177 -47.1421C302.388 135.091 445.428 624.964 197.582 453C-10.3946 308.699 524.999 5.64657 621.177 -47.1421C625.878 -49.8293 630.68 -52.4497 635.584 -55Z"
                fill="#84B8FF" fill-opacity="0.5" />
        </g>
        <defs>
            <filter id="filter0_f_12037_21162" x="0" y="-205" width="785.584" height="844.015"
                filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
                <feFlood flood-opacity="0" result="BackgroundImageFix" />
                <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
                <feGaussianBlur stdDeviation="75" result="effect1_foregroundBlur_12037_21162" />
            </filter>
        </defs>
    </svg>
    <svg xmlns="http://www.w3.org/2000/svg" width="764" height="627" viewBox="0 0 764 627" fill="none"
        class="position-absolute top-0 start-30 pointer-none z-n1">
        <g filter="url(#filter0_f_12037_21164)">
            <path
                d="M613.518 -76.3955C598.43 -76.9982 579.222 -75.25 557.274 -70.0875C379.139 -7.63588 520.56 463.515 274.893 475.677C60.7068 486.281 169.876 311.182 251.234 222.307C338.497 25.4619 469.701 -49.4896 557.274 -70.0875C573.274 -75.6968 591.851 -78.009 613.518 -76.3955Z"
                fill="#F5BEFF" fill-opacity="0.5" />
        </g>
        <defs>
            <filter id="filter0_f_12037_21164" x="0.0332031" y="-226.898" width="763.485" height="853.036"
                filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
                <feFlood flood-opacity="0" result="BackgroundImageFix" />
                <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
                <feGaussianBlur stdDeviation="75" result="effect1_foregroundBlur_12037_21164" />
            </filter>
        </defs>
    </svg>
    <svg xmlns="http://www.w3.org/2000/svg" width="1125" height="735" viewBox="0 0 1125 735" fill="none"
        class="position-absolute top-0 end-0 pointer-none z-n1">
        <g filter="url(#filter0_f_12037_21161)">
            <path
                d="M1164.47 -17.4061C1129.68 -15.6139 1120.14 -46.1203 1090.82 -53.2625C1059.6 -60.8721 1045.51 -41.9397 1042.18 -26.4602C1039.61 -14.5276 1034.2 -9.348 1019.95 -6.0301C1009.8 -4.1671 1000.8 1.11011 1003.16 15.5852C1005.51 30.0603 157.156 -18.678 150.045 -13.5C142.934 -8.321 979.879 56.4123 977.545 65.9903C973.593 82.2033 394.237 410.971 409.045 418.5C425.685 426.781 1022.01 124.06 1020.84 142.861C909.543 260.5 593.751 591.557 617.543 584C623.552 582.092 1077.17 150.224 1092.26 174.112C1096.01 180.06 1105.31 185.913 1113.81 187.987C1136.61 193.541 1159.91 176.739 1162.22 153.604C1164.73 136.486 1167.85 128.459 1186.35 134.438C1204.66 140.354 1215.62 114.869 1205.37 101.795C1191.15 87.0603 1208.12 60.5603 1213.51 38.4483C1220.87 8.2239 1194.85 -20.6978 1164.47 -17.4061Z"
                fill="#5C65FF" fill-opacity="0.4" />
        </g>
        <defs>
            <filter id="filter0_f_12037_21161" x="0" y="-205" width="1364.77" height="939.127"
                filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
                <feFlood flood-opacity="0" result="BackgroundImageFix" />
                <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
                <feGaussianBlur stdDeviation="75" result="effect1_foregroundBlur_12037_21161" />
            </filter>
        </defs>
    </svg>
    <img src="{$WEB_ROOT}/templates/{$template}/assets/img/hero-2-shape.png" alt="image"
        class="img-fluid position-absolute top-50 end-0 translate-middle-y z-n1">
</div>