{include file="orderforms/localhost_cart/common.tpl"}

<div id="order-standard_cart">
    <div class="row">
        <div class="cart-sidebar sidebar">
            {include file="orderforms/localhost_cart/sidebar-categories.tpl"}
        </div>
        <div class="cart-body">

            <div class="header-lined section-space-xsm-bottom">
                <h4 class="mb-2">
                    {if $productGroup.headline}
                        {$productGroup.headline}
                    {else}
                        {$productGroup.name}
                    {/if}
                </h4>
                {if $productGroup.tagLine}
                    <p class="mb-0">{$productGroup.tagLine}</p>
                {/if}
            </div>
            {if $errormessage}
                <div class="alert alert-danger">
                    {$errormessage}
                </div>
            {elseif !$productGroup}
                <div class="alert alert-info">
                    {lang key='orderForm.selectCategory'}
                </div>
            {/if}

            {include file="orderforms/localhost_cart/sidebar-categories-collapsed.tpl"}

            <div class="products m-0" id="products">
                <div class="row g-4 justify-content-center">
                    {foreach $products as $key => $product}
                        <div class="col-md-4 col-xxl-3">
                            <div
                                class="bg-body border rounded-3 px-4 px-xxl-8 py-6 py-xl-10 text-center h-100 {if $product.isFeatured}border-primary position-relative z-1{/if}">
                                {if $product.isFeatured}
                                    <span
                                        class="badge gap-1 bg-primary text-light fw-medium mb-2 position-absolute top-0 start-50 translate-middle">
                                        <span class="w-2 h-2 rounded-circle bg-light flex-shrink-0"></span>
                                        Recommended
                                    </span>
                                {/if}
                                <h6 class="mb-3 fs-20">{$product.name}</h6>
                                {if $product.tagLine}
                                    <p class="mb-0 fs-14">{$product.tagLine}</p>
                                {/if}
                                {* <p class="mb-0 mt-4 fs-14">{$product.description}</p> *}
                                {if $product.featuresdesc}
                                    <p id="{$idPrefix}-description" class="mb-0 mt-4 fs-14">
                                        {$product.featuresdesc}
                                    </p>
                                {/if}
                                {if $product.stockControlEnabled}
                                    <span class="qty">
                                        {$product.qty} {$LANG.orderavailable}
                                    </span>
                                {/if}
                                <div class="my-6">
                                    <h5 class="mb-0">
                                        {if $product.bid}
                                            {$LANG.bundledeal}<br />
                                            {if $product.displayprice}
                                                <span class="price">{$product.displayprice}</span>
                                            {/if}
                                        {else}
                                            {if $product.pricing.hasconfigoptions}
                                                {$LANG.startingfrom}
                                            {/if}
                                            {$product.pricing.minprice.price}
                                            <span class="d-inline fs-12 fw-normal">
                                                {if $product.pricing.minprice.cycle eq "monthly"}
                                                    {$LANG.orderpaymenttermmonthly}
                                                {elseif $product.pricing.minprice.cycle eq "quarterly"}
                                                    {$LANG.orderpaymenttermquarterly}
                                                {elseif $product.pricing.minprice.cycle eq "semiannually"}
                                                    {$LANG.orderpaymenttermsemiannually}
                                                {elseif $product.pricing.minprice.cycle eq "annually"}
                                                    {$LANG.orderpaymenttermannually}
                                                {elseif $product.pricing.minprice.cycle eq "biennially"}
                                                    {$LANG.orderpaymenttermbiennially}
                                                {elseif $product.pricing.minprice.cycle eq "triennially"}
                                                    {$LANG.orderpaymenttermtriennially}
                                                {/if}
                                            </span>
                                        {/if}
                                    </h5>
                                </div>
                                <a href="{$product.productUrl}"
                                    class="btn {if $product.isFeatured}btn-primary{else}btn-primary-subtle{/if}  border-0 align-items-center">
                                    <span class="d-inline-block fs-14 fw-medium flex-grow-1"> {$LANG.ordernowbutton} </span>
                                    <iconify-icon icon="bitcoin-icons:arrow-right-filled"
                                        class="align-middle flex-shrink-0">
                                    </iconify-icon>
                                </a>

                                <ul class="list gap-3 mt-6 px-md-2">
                                    {foreach $product.features as $feature => $value}
                                        <li id="{$idPrefix}-feature{$value@iteration}" class="d-flex gap-2 align-items-center">
                                            <iconify-icon icon="material-symbols:check-rounded"
                                                class="fs-20 text-success flex-shrink-0"></iconify-icon>
                                            <span class="d-block text-start fs-14">
                                                {$feature}
                                            </span>
                                        </li>
                                    {/foreach}
                                </ul>
                            </div>
                        </div>
                    {/foreach}
                </div>
            </div>
        </div>
    </div>
</div>

{include file="orderforms/localhost_cart/recommendations-modal.tpl"}