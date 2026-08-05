<div class="providerLinkingFeedback"></div>

<div class="bg-body min-vh-100 d-flex flex-column justify-content-center align-items-center authentication-page-2">
    <div class="container">
        <div class="row justify-content-center">
            <div class="col-md-10 col-lg-7 col-xl-6 col-xxl-5">
                <div class="bg-body rounded-3 section-space-sm-y px-4 px-md-12">
                    <p class="mb-2 text-heading fw-semibold fs-18 text-center">
                        Welcome !
                    </p>
                    <h4 class="text-center">Sign In Now</h4>
                    <p class="mb-0 text-center">{lang key='userLogin.signInToContinue'}</p>
                    {include file="$template/includes/flashmessage.tpl"}
                    <ul class="list list-row justify-content-center flex-wrap gap-4 my-10">
                        <li>
                            <button type="button" class="btn btn-light shadow align-items-center">
                                <iconify-icon icon="logos:facebook" class="align-middle fs-20 flex-shrink-0">
                                </iconify-icon>
                                <span class="d-inline-block fs-14 fw-medium flex-grow-1">
                                    Facebook
                                </span>
                            </button>
                        </li>
                        <li>
                            <button type="button" class="btn btn-light shadow align-items-center">
                                <iconify-icon icon="logos:google-icon" class="align-middle fs-20 flex-shrink-0">
                                </iconify-icon>
                                <span class="d-inline-block fs-14 fw-medium flex-grow-1">
                                    Google
                                </span>
                            </button>
                        </li>
                        <li>
                            <button type="button" class="btn btn-light shadow align-items-center">
                                <iconify-icon icon="logos:apple" class="align-middle fs-20 flex-shrink-0">
                                </iconify-icon>
                                <span class="d-inline-block fs-14 fw-medium flex-grow-1">
                                    Apple
                                </span>
                            </button>
                        </li>
                    </ul>
                    <form method="post" action="{routePath('login-validate')}" class="row g-4 align-items-center">
                        <div class="col-12">
                            <label for="inputEmail" class="form-label fw-medium text-heading">
                                {lang key='clientareaemail'}
                            </label>
                            <input type="email" id="inputEmail" class="form-control" placeholder="Email"
                                name="username" />
                        </div>
                        <div class="col-12">
                            <label for="inputPassword" class="form-label fw-medium text-heading">
                                {lang key='clientareapassword'}
                            </label>
                            <input type="password" id="inputPassword" class="form-control"
                                placeholder="{lang key='clientareapassword'}" name="password" autocomplete="off" />
                        </div>
                        <div class="col-sm-6">
                            <div class="form-check form-check--primary form-check-modifier">
                                <input class="form-check-input" type="checkbox" value="" id="remember-me"
                                    name="rememberme" />
                                <label class="form-check-label" for="remember-me">
                                    {lang key='loginrememberme'}
                                </label>
                            </div>
                        </div>
                        <div class="col-sm-6 text-sm-end">
                            <a href="{routePath('password-reset-begin')}"
                                class="link d-inline-block text-body hover:text-primary">{lang key='forgotpw'}</a>
                        </div>
                        <div class="col-12">
                            <button id="login" type="submit"
                                class="btn btn-primary w-100 justify-content-center {$captcha->getButtonClass($captchaForm)}">
                                {lang key='loginbutton'}
                            </button>
                        </div>
                    </form>
                    <p class="mt-6 mb-0 text-center">
                        {lang key='userLogin.notRegistered'}
                        <a href="{$WEB_ROOT}/register.php"
                            class="link d-inline-block fw-medium text-primary hover:text-primary-emphasis">
                            {lang key='userLogin.createAccount'}
                        </a>
                    </p>
                </div>
            </div>
        </div>
    </div>
    <svg xmlns="http://www.w3.org/2000/svg" width="1124" height="401" viewBox="0 0 1124 401" fill="none"
        class="banner-1__froster-svg">
        <g filter="url(#filter0_f_8077_2641)">
            <path
                d="M773.993 103.763C800.457 67.556 838.118 -16 889.598 -16C932.68 -16 925.405 109.955 850.192 214.4C676.015 417.658 548.024 427 432.419 427C316.814 427 267 368.356 267 332.149C267 295.942 301.82 244.415 489.854 244.415C677.886 244.415 747.529 139.97 773.993 103.763Z"
                fill="#6328FF" fill-opacity="0.5" class="banner-1__froster-svg-path" />
        </g>
        <defs>
            <filter id="filter0_f_8077_2641" x="0.333405" y="-282.667" width="1182.33" height="976.333"
                filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
                <feFlood flood-opacity="0" result="BackgroundImageFix" />
                <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
                <feGaussianBlur stdDeviation="133.333" result="effect1_foregroundBlur_8077_2641" />
            </filter>
        </defs>
    </svg>
</div>