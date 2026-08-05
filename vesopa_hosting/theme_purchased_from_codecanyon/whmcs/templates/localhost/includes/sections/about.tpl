<div class="section-space-md-y">
    <div class="section-space-md-bottom">
        <div class="container">
            <div class="row g-4 align-items-center">
                <div class="col-lg-6">
                    <div class="position-relative z-1">
                        <img src="{$WEB_ROOT}/templates/{$template}{$aboutContent.homepage.img}" alt="image"
                            class="img-fluid">
                        <svg xmlns="http://www.w3.org/2000/svg" width="720" height="721" viewBox="0 0 720 721"
                            fill="none" class="position-absolute top-0 start-0 z-n1 pointer-none d-none d-xl-block">
                            <g filter="url(#filter0_f_12044_1067)">
                                <path
                                    d="M570 150C569.329 150.348 564.936 152.449 557.539 156.081C281.806 297.107 405.527 676.208 191.155 543.129C11.2685 431.457 474.352 196.932 557.539 156.081C561.605 154.001 565.758 151.974 570 150Z"
                                    fill="#84B8FF" fill-opacity="0.5" />
                            </g>
                            <defs>
                                <filter id="filter0_f_12044_1067" x="0" y="0" width="720" height="721"
                                    filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
                                    <feFlood flood-opacity="0" result="BackgroundImageFix" />
                                    <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
                                    <feGaussianBlur stdDeviation="75" result="effect1_foregroundBlur_12044_1067" />
                                </filter>
                            </defs>
                        </svg>
                        <svg xmlns="http://www.w3.org/2000/svg" width="701" height="729" viewBox="0 0 701 729"
                            fill="none" class="position-absolute top-0 start-0 z-n1 pointer-none d-none d-xl-block">
                            <g filter="url(#filter0_f_12044_1068)">
                                <path
                                    d="M551 150.92C537.951 150.454 521.34 151.807 502.358 155.801C348.3 204.127 470.606 568.708 258.143 578.119C72.907 586.324 167.321 450.831 237.683 382.059C313.151 229.738 426.622 171.74 502.358 155.801C516.195 151.461 532.261 149.672 551 150.92Z"
                                    fill="#F5BEFF" fill-opacity="0.5" />
                            </g>
                            <defs>
                                <filter id="filter0_f_12044_1068" x="0.160156" y="0.531006" width="700.84"
                                    height="727.945" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
                                    <feFlood flood-opacity="0" result="BackgroundImageFix" />
                                    <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
                                    <feGaussianBlur stdDeviation="75" result="effect1_foregroundBlur_12044_1068" />
                                </filter>
                            </defs>
                        </svg>
                    </div>
                </div>
                <div class="col-lg-6">
                    <span class="d-block mb-2 fs-14 fw-medium text-primary">
                        {$aboutContent.homepage.subtitle}
                    </span>
                    <h3 class="mb-6">{$aboutContent.homepage.title}</h3>
                    <p>{$aboutContent.homepage.description.text_1}</p>
                    <p class="mb-0">{$aboutContent.homepage.description.text_2}</p>
                </div>
            </div>
        </div>
    </div>
    <div class="container">
        <div class="row g-4">
            {foreach from=$aboutContent.homepage.features item=feature}
                <div class="col-md-6 col-lg-4">
                    <div class="p-6 p-sm-8 p-xxl-10 bg-body rounded-3 position-relative z-1 h-100">
                        <img src="{$WEB_ROOT}/templates/{$template}/{$feature.img}" alt="image" class="img-fluid mb-6">
                        <h6>{$feature.title}</h6>
                        <p class="mb-0">{$feature.description}</p>
                    </div>
                </div>
            {/foreach}
        </div>
    </div>
</div>