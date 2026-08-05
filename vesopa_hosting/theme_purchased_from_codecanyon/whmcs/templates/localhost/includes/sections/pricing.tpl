<div class="section-space-md-y">
    <div class="section-space-md-bottom">
        <div class="container">
            <div class="row justify-content-center">
                <div class="col-md-8 col-xl-7 col-xxl-6">
                    <h3 class="mb-0 text-center">
                        {$generalLang['pricing.homepage.title']}
                    </h3>
                </div>
            </div>
        </div>
    </div>
    <div class="container">
        <div class="row g-4 justify-content-center">
            {foreach from=$group.products item=product key=idx}
                <div class="col-md-4 col-xxl-3">
                    <div
                        class="bg-body border rounded-3 px-4 px-xxl-8 py-6 py-xl-10 text-center h-100 {if $product.details[$idx]->is_featured}border-primary position-relative z-1{/if}">
                        {if $product.details[$idx]->is_featured}
                            <span
                                class="badge gap-1 bg-primary text-light fw-medium mb-2 position-absolute top-0 start-50 translate-middle">
                                <span class="w-2 h-2 rounded-circle bg-light flex-shrink-0"></span>
                                Recommended
                            </span>
                        {/if}
                        <h6 class="mb-3 fs-20">{$product.name}</h6>
                        <p class="mb-6 fs-14">{$product.tagline}</p>
                        <span class="badge gap-1 bg-primary-subtle text-primary fw-semibold mb-2">
                            <span class="w-2 h-2 rounded-circle bg-primary flex-shrink-0"></span> Save 20% </span>
                        <span class="d-block fs-12"> Starting at <span
                                class="d-inline-block fw-bold text-decoration-line-through"> US$ 11.99 </span>
                        </span>
                        <div class="my-6">
                            <h5 class="mb-0">
                                {$product.price}
                            </h5>
                        </div>
                        <a href="{$product.cartUrl}"
                            class="btn {if $product.details[$idx]->is_featured}btn-primary{else}btn-primary-subtle{/if}  border-0 align-items-center">
                            <span class="d-inline-block fs-14 fw-medium flex-grow-1"> Explore Now </span>
                            <iconify-icon icon="bitcoin-icons:arrow-right-filled" class="align-middle flex-shrink-0">
                            </iconify-icon>
                        </a>
                        <p class="mb-0 mt-4 fs-14">{$product.description}</p>

                        <ul class="list gap-3 mt-6 px-md-2">
                            {foreach from=$product.features item=feature}
                                <li class="d-flex gap-2 align-items-center">
                                    <iconify-icon icon="material-symbols:check-rounded"
                                        class="fs-20 text-success flex-shrink-0"></iconify-icon>
                                    <span class="d-block text-start fs-14">
                                        {$feature}
                                </li>
                            {/foreach}
                        </ul>
                    </div>
                </div>
            {/foreach}
        </div>
    </div>
</div>