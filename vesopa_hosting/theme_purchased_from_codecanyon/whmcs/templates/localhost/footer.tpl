    </div>

    </div>
    {if !$inShoppingCart && $secondarySidebar->hasChildren()}
        <div class="d-lg-none sidebar sidebar-secondary">
            {include file="$template/includes/sidebar.tpl" sidebar=$secondarySidebar}
        </div>
    {/if}
    <div class="clearfix"></div>
    </div>
    </div>
    </section>

    <footer id="footer" class="section-space-md-y position-relative z-1 overflow-hidden bg-primary-subtle dark:bg-dark-subtle">
        <div class="container">
            <div class="row g-4">
                <div class="col-md-8 col-lg-6 col-xl-3">
                    <div class="d-flex flex-column h-100 align-items-start">
                        {if $assetLogoPath}
                            <a class="logo text-decoration-none fw-semibold text-light transition mb-5"
                                href="{$WEB_ROOT}/index.php">
                                <img src="{$assetLogoPath}" alt="{$companyname}" class="logo__img">
                            </a>
                        {else}
                            <h6 class="mb-6 fs-18">
                                <a class="text-decoration-none text-heading transition" href="{$WEB_ROOT}/index.php">
                                    {$companyname}
                                </a>
                            </h6>
                        {/if}
                        <p class="mb-8">
                            {$generalLang['footer.text']}
                        </p>
                        <p class="mb-6 mt-auto">
                            {lang key="copyrightFooterNotice" year=$date_year company=$companyname}
                        </p>
                        {if $languagechangeenabled && count($locales) > 1 || $currencies}
                            <button type="button" class="btn btn-primary-subtle align-items-center" data-toggle="modal"
                                data-target="#modalChooseLanguage">
                                <div class="d-inline-block align-middle">
                                    <div
                                        class="iti-flag {if $activeLocale.countryCode === '001'}us{else}{$activeLocale.countryCode|lower}{/if}">
                                    </div>
                                </div>
                                <span class="d-inline-block fs-14 fw-semibold">
                                    {$activeLocale.localisedName}
                                    /
                                    {$activeCurrency.prefix}
                                    {$activeCurrency.code}
                                </span>
                            </button>
                        {/if}
                        <ul class="list list-row justify-content-sm-end gap-4 flex-wrap mt-6">
                            {foreach $socialAccounts as $account}
                                <li>
                                    <a href="{$account->getUrl()}"
                                        class="link d-inline-block text-body hover:text-primary fs-24">
                                        <i class="{$account->getFontAwesomeIcon()}"></i>
                                    </a>
                                </li>
                            {/foreach}
                        </ul>
                    </div>
                </div>
                <div class="col-xl-9">
                    <div class="row row-cols-1 row-cols-sm-2 row-cols-md-5 g-4 justify-content-xl-around">
                        <div class="col">
                            <h6 class="mb-6 fs-18">Services</h6>
                            <ul class="list gap-2">
                                <li>
                                    <a href="index.php?rp=/store"
                                        class="link d-inline-block text-heading hover:text-primary fs-14">
                                        Browse All
                                    </a>
                                </li>
                                <li>
                                    <a href="index.php?rp=/store/web-hosting"
                                        class="link d-inline-block text-heading hover:text-primary fs-14">
                                        Web Hosting
                                    </a>
                                </li>
                                <li>
                                    <a href="cart.php?a=add&domain=register"
                                        class="link d-inline-block text-heading hover:text-primary fs-14">
                                        Resgister Domain
                                    </a>
                                </li>
                                <li>
                                    <a href="cart.php?a=add&domain=transfer"
                                        class="link d-inline-block text-heading hover:text-primary fs-14">
                                        Transfer Domain
                                    </a>
                                </li>
                            </ul>
                        </div>
                        <div class="col">
                            <h6 class="mb-6 fs-18">Features</h6>
                            <ul class="list gap-2">
                                <li>
                                    <a href="{routePath('announcement-index')}"
                                        class="link d-inline-block text-heading hover:text-primary fs-14">
                                        {lang key='announcementstitle'}
                                    </a>
                                </li>
                                <li>
                                    <a href="serverstatus.php"
                                        class="link d-inline-block text-heading hover:text-primary fs-14">
                                        {lang key='networkstatustitle'}
                                    </a>
                                </li>
                                <li>
                                    <a href="{routePath('knowledgebase-index')}"
                                        class="link d-inline-block text-heading hover:text-primary fs-14">
                                        {lang key='knowledgebasetitle'}
                                    </a>
                                </li>
                                <li>
                                    <a href="{routePath('download-index')}"
                                        class="link d-inline-block text-heading hover:text-primary fs-14">
                                        {lang key='downloadstitle'}
                                    </a>
                                </li>
                            </ul>
                        </div>
                        <div class="col">
                            <h6 class="mb-6 fs-18">Tools</h6>
                            <ul class="list gap-2">
                                <li>
                                    <a href="submitticket.php"
                                        class="link d-inline-block text-heading hover:text-primary fs-14">
                                        {lang key='homepage.submitTicket'}
                                    </a>
                                </li>
                                <li>
                                    <a href="clientarea.php"
                                        class="link d-inline-block text-heading hover:text-primary fs-14">
                                        {lang key='homepage.yourAccount'}
                                    </a>
                                </li>
                                <li>
                                    <a href="clientarea.php?action=services"
                                        class="link d-inline-block text-heading hover:text-primary fs-14">
                                        {lang key='homepage.manageServices'}
                                    </a>
                                </li>
                                <li>
                                    <a href="clientarea.php?action=domains"
                                        class="link d-inline-block text-heading hover:text-primary fs-14">
                                        {lang key='homepage.manageDomains'}
                                    </a>
                                </li>
                            </ul>
                        </div>
                        <div class="col">
                            <h6 class="mb-6 fs-18">Company</h6>
                            <ul class="list gap-2">
                                <li>
                                    <a href="supporttickets.php"
                                        class="link d-inline-block text-heading hover:text-primary fs-14">
                                        {lang key='homepage.supportRequests'}
                                    </a>
                                </li>
                                <li>
                                    <a href="clientarea.php?action=masspay&all=true"
                                        class="link d-inline-block text-heading hover:text-primary fs-14">
                                        {lang key='homepage.makeAPayment'}
                                    </a>
                                </li>
                            </ul>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </footer>

    <div id="fullpage-overlay" class="w-hidden">
        <div class="outer-wrapper">
            <div class="inner-wrapper">
                <img src="{$WEB_ROOT}/assets/img/overlay-spinner.svg" alt="">
                <br>
                <span class="msg"></span>
            </div>
        </div>
    </div>

    <div class="modal system-modal fade" id="modalAjax" tabindex="-1" role="dialog" aria-hidden="true">
        <div class="modal-dialog">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title"></h5>
                    <button type="button" class="close" data-dismiss="modal">
                        <span aria-hidden="true">&times;</span>
                        <span class="sr-only">{lang key='close'}</span>
                    </button>
                </div>
                <div class="modal-body">
                    {lang key='loading'}
                </div>
                <div class="modal-footer">
                    <div class="float-left loader">
                        <i class="fas fa-circle-notch fa-spin"></i>
                        {lang key='loading'}
                    </div>
                    <button type="button" class="btn btn-default" data-dismiss="modal">
                        {lang key='close'}
                    </button>
                    <button type="button" class="btn btn-primary modal-submit">
                        {lang key='submit'}
                    </button>
                </div>
            </div>
        </div>
    </div>

    <div class="modal fade" id="searchModal" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content bg-transparent border-0">
                <div class="p-2">
                    <form method="post" action="{routePath('knowledgebase-search')}"
                        class="d-flex align-items-center bg-light-subtle border border-light border-opacity-10 rounded-2 p-1">
                        <input type="text" name="search"
                            class="form-control bg-transparent border-0 py-1 fs-14 text-dark-emphasis text-opacity-80 placeholder::text-light-emphasis"
                            placeholder="{lang key="searchOurKnowledgebase"}...">
                        <button type="submit"
                            class="btn border-0 d-grid place-content-center p-0 bg-primary dark:bg-primary-subtle bg-opacity-20 hover:bg-primary text-primary-emphasis hover:text-light w-10 h-10 flex-shrink-0 rounded-2 transition">
                            <i class="bi bi-search"></i>
                        </button>
                    </form>
                </div>
            </div>
        </div>
    </div>

    <form method="get" action="{$currentpagelinkback}">
        <div class="modal modal-localisation" id="modalChooseLanguage" tabindex="-1" role="dialog">
            <div class="modal-dialog modal-lg" role="document">
                <div class="modal-content">
                    <div class="modal-body">
                        <button type="button" class="close text-light" data-dismiss="modal" aria-label="Close">
                            <span aria-hidden="true">&times;</span>
                        </button>

                        {if $languagechangeenabled && count($locales) > 1}
                            <h5 class="h5 pt-5 pb-3">{lang key='chooselanguage'}</h5>
                            <div class="row item-selector">
                                <input type="hidden" name="language" data-current="{$language}" value="{$language}" />
                                {foreach $locales as $locale}
                                    <div class="col-4">
                                        <a href="#" class="item{if $language == $locale.language} active{/if}"
                                            data-value="{$locale.language}">
                                            {$locale.localisedName}
                                        </a>
                                    </div>
                                {/foreach}
                            </div>
                        {/if}
                        {if !$loggedin && $currencies}
                            <p class="h5 pt-5 pb-3">{lang key='choosecurrency'}</p>
                            <div class="row item-selector">
                                <input type="hidden" name="currency" data-current="{$activeCurrency.id}" value="">
                                {foreach $currencies as $selectCurrency}
                                    <div class="col-4">
                                        <a href="#" class="item{if $activeCurrency.id == $selectCurrency.id} active{/if}"
                                            data-value="{$selectCurrency.id}">
                                            {$selectCurrency.prefix} {$selectCurrency.code}
                                        </a>
                                    </div>
                                {/foreach}
                            </div>
                        {/if}
                    </div>
                    <div class="modal-footer">
                        <button type="submit"
                            class="btn btn-primary btn-xl fs-14 fw-semibold">{lang key='apply'}</button>
                    </div>
                </div>
            </div>
        </div>
    </form>

    {if !$loggedin && $adminLoggedIn}
        <a href="{$WEB_ROOT}/logout.php?returntoadmin=1" class="btn btn-return-to-admin" data-toggle="tooltip"
            data-placement="bottom"
            title="{if $adminMasqueradingAsClient}{lang key='adminmasqueradingasclient'} {lang key='logoutandreturntoadminarea'}{else}{lang key='adminloggedin'} {lang key='returntoadminarea'}{/if}">
            <i class="fas fa-redo-alt"></i>
            <span class="d-none d-md-inline-block">{lang key="admin.returnToAdmin"}</span>
        </a>
    {/if}

    {include file="$template/includes/generate-password.tpl"}

    {$footeroutput}
    <script src="{$WEB_ROOT}/templates/{$template}/assets/js/bootstrap.bundle.js"></script>
    <script src="{$WEB_ROOT}/templates/{$template}/assets/js/iconify.js"></script>
    <script src="{$WEB_ROOT}/templates/{$template}/assets/js/swiper.js"></script>
    <script src="{$WEB_ROOT}/templates/{$template}/assets/js/custom.js"></script>
    </body>

</html>