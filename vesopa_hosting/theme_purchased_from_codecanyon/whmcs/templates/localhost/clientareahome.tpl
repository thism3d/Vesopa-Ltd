{include file="$template/includes/flashmessage.tpl"}

<div class="tiles mb-4">
    <div class="row">
        <div class="col-6 col-xl-3">
            <a href="clientarea.php?action=services"
                class="link d-block p-5 rounded bg-primary-subtle position-relative z-1">
                <span class="d-block h4 mb-1 text-primary-emphasis">
                    {$clientsstats.productsnumactive}
                </span>
                <span class="d-block text-primary-emphasis fs-14 fw-medium">
                    {lang key='navservices'}
                </span>
                <span class="d-block position-absolute top-3 end-3 fs-48 text-primary text-opacity-30">
                    <i class="fas fa-cube"></i>
                </span>
            </a>
        </div>
        {if $clientsstats.numdomains || $registerdomainenabled || $transferdomainenabled}
            <div class="col-6 col-xl-3">
                <a href="clientarea.php?action=domains"
                    class="link d-block p-5 rounded bg-success-subtle position-relative z-1">
                    <span class="d-block h4 mb-1 text-success-emphasis">
                        {$clientsstats.numactivedomains}
                    </span>
                    <span class="d-block text-success-emphasis fs-14 fw-medium">
                        {lang key='navdomains'}
                    </span>
                    <span class="d-block position-absolute top-3 end-3 fs-48 text-success text-opacity-30">
                        <i class="fas fa-globe"></i>
                    </span>
                </a>
            </div>
        {elseif $condlinks.affiliates && $clientsstats.isAffiliate}
            <div class="col-6 col-xl-3">
                <a href="affiliates.php" class="link d-block p-5 rounded bg-danger-subtle position-relative z-1">
                    <span class="d-block h4 mb-1 text-danger-emphasis">
                        {$clientsstats.numaffiliatesignups}
                    </span>
                    <span class="d-block text-danger-emphasis fs-14 fw-medium">
                        {lang key='affiliatessignups'}
                    </span>
                    <span class="d-block position-absolute top-3 end-3 fs-48 text-danger text-opacity-30">
                        <i class="fas fa-shopping-cart"></i>
                    </span>
                </a>
            </div>
        {else}
            <div class="col-6 col-xl-3">
                <a href="clientarea.php?action=quotes"
                    class="link d-block p-5 rounded bg-danger-subtle position-relative z-1">
                    <span class="d-block h4 mb-1 text-danger-emphasis">
                        {$clientsstats.numquotes}
                    </span>
                    <span class="d-block text-danger-emphasis fs-14 fw-medium">
                        {lang key='quotes'}
                    </span>
                    <span class="d-block position-absolute top-3 end-3 fs-48 text-danger text-opacity-30">
                        <i class="far fa-file-alt"></i>
                    </span>
                </a>
            </div>
        {/if}
        <div class="col-6 col-xl-3">
            <a href="supporttickets.php" class="link d-block p-5 rounded bg-danger-subtle position-relative z-1">
                <span class="d-block h4 mb-1 text-danger-emphasis">
                    {$clientsstats.numactivetickets}
                </span>
                <span class="d-block text-danger-emphasis fs-14 fw-medium">
                    {lang key='navtickets'}
                </span>
                <span class="d-block position-absolute top-3 end-3 fs-48 text-danger text-opacity-30">
                    <i class="fas fa-comments"></i>
                </span>
            </a>
        </div>
        <div class="col-6 col-xl-3">
            <a href="supporttickets.php" class="link d-block p-5 rounded bg-info-subtle position-relative z-1">
                <span class="d-block h4 mb-1 text-info-emphasis">
                    {$clientsstats.numunpaidinvoices}
                </span>
                <span class="d-block text-info-emphasis fs-14 fw-medium">
                    {lang key='navinvoices'}
                </span>
                <span class="d-block position-absolute top-3 end-3 fs-48 text-info text-opacity-30">
                    <i class="fas fa-credit-card"></i>
                </span>
            </a>
        </div>
    </div>
</div>

{foreach $addons_html as $addon_html}
    <div>
        {$addon_html}
    </div>
{/foreach}

{if $captchaError}
    <div class="alert alert-danger">
        {$captchaError}
    </div>
{/if}

<div class="client-home-cards">
    <div class="row">
        <div class="col-12">
            {function name=outputHomePanels}
                <div menuItemName="{$item->getName()}"
                    class="card card-accent-{$item->getExtra('color')}{if $item->getClass()} {$item->getClass()}{/if}"
                    {if $item->getAttribute('id')} id="{$item->getAttribute('id')}" {/if}>
                    <div class="card-header">
                        <h3 class="card-title m-0">
                            {if $item->getExtra('btn-link') && $item->getExtra('btn-text')}
                                <div class="float-right">
                                    <a href="{$item->getExtra('btn-link')}"
                                        class="btn btn-default bg-color-{$item->getExtra('color')} btn-xs">
                                        {if $item->getExtra('btn-icon')}<i class="{$item->getExtra('btn-icon')}"></i>{/if}
                                        {$item->getExtra('btn-text')}
                                    </a>
                                </div>
                            {/if}
                            {if $item->hasIcon()}<i class="{$item->getIcon()}"></i>&nbsp;{/if}
                            {$item->getLabel()}
                            {if $item->hasBadge()}&nbsp;<span class="badge">{$item->getBadge()}</span>{/if}
                        </h3>
                    </div>
                    {if $item->hasBodyHtml()}
                        <div class="card-body">
                            {$item->getBodyHtml()}
                        </div>
                    {/if}
                    {if $item->hasChildren()}
                        <div
                            class="list-group{if $item->getChildrenAttribute('class')} {$item->getChildrenAttribute('class')}{/if}">
                            {foreach $item->getChildren() as $childItem}
                                {if $childItem->getUri()}
                                    <a menuItemName="{$childItem->getName()}" href="{$childItem->getUri()}"
                                        class="list-group-item list-group-item-action{if $childItem->getClass()} {$childItem->getClass()}{/if}{if $childItem->isCurrent()} active{/if}"
                                        {if $childItem->getAttribute('dataToggleTab')} data-toggle="tab"
                                            {/if}{if $childItem->getAttribute('target')} target="{$childItem->getAttribute('target')}" {/if}
                                            id="{$childItem->getId()}">
                                            {if $childItem->hasIcon()}<i class="{$childItem->getIcon()}"></i>&nbsp;{/if}
                                            {$childItem->getLabel()}
                                            {if $childItem->hasBadge()}&nbsp;<span class="badge">{$childItem->getBadge()}</span>{/if}
                                        </a>
                                    {else}
                                        <div menuItemName="{$childItem->getName()}"
                                            class="list-group-item list-group-item-action{if $childItem->getClass()} {$childItem->getClass()}{/if}"
                                            id="{$childItem->getId()}">
                                            {if $childItem->hasIcon()}<i class="{$childItem->getIcon()}"></i>&nbsp;{/if}
                                            {$childItem->getLabel()}
                                            {if $childItem->hasBadge()}&nbsp;<span class="badge">{$childItem->getBadge()}</span>{/if}
                                        </div>
                                    {/if}
                                {/foreach}
                            </div>
                        {/if}
                        <div class="card-footer">
                            {if $item->hasFooterHtml()}
                                {$item->getFooterHtml()}
                            {/if}
                        </div>
                    </div>
                {/function}

                {foreach $panels as $item}
                    {if $item->getExtra('colspan')}
                        {outputHomePanels}
                        {assign "panels" $panels->removeChild($item->getName())}
                    {/if}
                {/foreach}

            </div>
            <div class="col-md-6 col-lg-12 col-xl-6">

                {foreach $panels as $item}
                    {if $item@iteration is odd}
                        {outputHomePanels}
                    {/if}
                {/foreach}

            </div>
            <div class="col-md-6 col-lg-12 col-xl-6">

                {foreach $panels as $item}
                    {if $item@iteration is even}
                        {outputHomePanels}
                    {/if}
                {/foreach}

            </div>
        </div>
    </div>