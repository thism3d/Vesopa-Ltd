<div class="section-space-md-y">
    <div class="container">
        <div class="row align-items-center">
            <div class="col-lg-5">
                <div class="pb-8 pb-lg-0">
                    <h3 class="text-center text-lg-start">
                        {$generalLang['service.section.title']}
                    </h3>
                    <p class="mb-0 text-center text-lg-start">
                        {$generalLang['service.section.subtitle']}
                    </p>
                </div>
            </div>
            <div class="col-lg-7">
                <div class="row g-4">
                    {if $registerdomainenabled}
                        <div class="col-md-6">
                            <div class="p-6 p-sm-8 bg-body rounded-3 position-relative z-1 h-100">
                                <img src="{$WEB_ROOT}/templates/{$template}/assets/img/icon-feature-7.png" alt="image"
                                    class="img-fluid">
                                <h6 class="mt-6">{lang key='orderregisterdomain'}</h6>
                                <p class="mb-8">{lang key='secureYourDomain'}</p>
                                <a href="{$WEB_ROOT}/cart.php?a=add&domain=register"
                                    class="btn btn-secondary-emphasis hover:text-light fw-medium">
                                    {lang key='navdomainsearch'}
                                </a>
                            </div>
                        </div>
                    {/if}
                    {if $transferdomainenabled}
                        <div class="col-md-6">
                            <div class="p-6 p-sm-8 bg-body rounded-3 position-relative z-1 h-100">
                                <img src="{$WEB_ROOT}/templates/{$template}/assets/img/icon-feature-8.png" alt="image"
                                    class="img-fluid">
                                <h6 class="mt-6">{lang key='transferYourDomain'}</h6>
                                <p class="mb-8">{lang key='transferExtend'}</p>
                                <a href="{$WEB_ROOT}/cart.php?a=add&domain=transfer"
                                    class="btn btn-secondary-emphasis hover:text-light fw-medium">
                                    {$generalLang['transferDomain']}
                                </a>
                            </div>
                        </div>
                    {/if}
                </div>
            </div>
        </div>
    </div>
</div>