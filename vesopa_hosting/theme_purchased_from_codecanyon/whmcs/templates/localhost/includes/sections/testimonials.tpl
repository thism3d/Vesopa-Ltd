<div class="testimonial-section-2 section-space-y bg-primary-subtle dark:bg-dark-subtle">
    <div class="container">
        <div class="row g-4 align-items-center">
            <div class="col-md-6 col-xxl-5">
                <h3>{$generalLang['testimonial.section.title']}</h3>
                <p class="mb-8 max-text-12">
                    {$generalLang['testimonial.section.subtitle']}
                </p>
                <img src="{$WEB_ROOT}/templates/{$template}/assets/img/trustpilot-img.png" alt="image"
                    class="img-fluid" />
            </div>
            <div class="col-md-6 col-xxl-7">
                <div class="swiper testimonial-slider-5">
                    <div class="swiper-wrapper">
                        {foreach from=$testimonialsSwiper item=testimonial}
                            <div class="swiper-slide">
                                <div class="p-6 p-md-8 rounded-4 bg-body h-100">
                                    <div class="d-flex align-items-center justify-content-between gap-4 mb-6">
                                        <div class="d-flex align-items-center gap-4">
                                            <div
                                                class="w-15 h-15 d-grid place-content-center rounded-circle overflow-hidden flex-shrink-0">
                                                <img src="{$WEB_ROOT}/templates/{$template}/assets/img/{$testimonial.avatar}"
                                                    alt="image" class="w-100 h-100 object-fit-cover" />
                                            </div>
                                            <div class="flex-grow-1">
                                                <span class="d-block mb-2 fs-18 fw-semibold text-heading">
                                                    {$testimonial.name}
                                                </span>
                                                <ul class="list list-row gap-1">
                                                    {section name=star loop=$testimonial.rating}
                                                        <li>
                                                            <div
                                                                class="d-flex align-items-center justify-content-center w-6 h-6 bg-success text-light">
                                                                <iconify-icon icon="material-symbols:star"></iconify-icon>
                                                            </div>
                                                        </li>
                                                    {/section}
                                                </ul>
                                            </div>
                                        </div>
                                        <iconify-icon icon="oi:double-quote-sans-right"
                                            class="d-none d-sm-block fs-40 text-secondary"></iconify-icon>
                                    </div>
                                    <p class="mb-6">
                                        “ {$testimonial.quote} ”
                                    </p>
                                    <img src="{$WEB_ROOT}/templates/{$template}/assets/img/{$testimonial.brand}" alt="image"
                                        class="img-fluid" />
                                </div>
                            </div>
                        {/foreach}
                    </div>
                </div>
            </div>
        </div>
    </div>
</div>