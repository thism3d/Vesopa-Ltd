{foreach $sidebar as $item}
    {if $item->getName() === 'Client Details'}
        <div class="p-4 p-md-6 rounded bg-secondary dark:bg-dark-subtle border border-primary border-opacity-10 mb-4">
            {if $logo}
                <a class="w-12 h-12 rounded-circle overflow-hidden d-inline-block text-decoration-none fw-semibold text-light transition mb-4"
                    href="{$WEB_ROOT}/index.php">
                    <img src="{$logo}" alt="{$companyname}" class="logo__img">
                </a>
                {if $item->hasBodyHtml()}
                    <div class="mb-4 text-light">
                        {$item->getBodyHtml()}
                    </div>
                {/if}
                {if $item->hasFooterHtml()}
                    <div class="btn-container">
                        {$item->getFooterHtml()}
                    </div>
                {/if}
            {/if}
        </div>
    {else}
        <div class="p-1 rounded bg-light dark:bg-dark-subtle border border-primary border-opacity-10 mb-4 {if $item->getClass()} {$item->getClass()}{/if}{if $item->getExtra('mobileSelect') and $item->hasChildren()} d-none d-md-block{/if}"
            menuItemName="{$item->getName()}" {if $item->getAttribute('id')} id="{$item->getAttribute('id')}" {/if}>
            <div class="p-4 px-md-6 d-flex align-items-center gap-2">
                {if $item->hasIcon()}<i class="{$item->getIcon()} fs-16 text-heading"></i>{/if}
                <h6 class="mb-0 fs-20 d-flex align-items-center gap-2 fw-semibold">
                    {$item->getLabel()}
                    {if $item->hasBadge()}
                        <span class="badge text-bg-secondary">{$item->getBadge()}</span>
                    {/if}
                </h6>
            </div>
            <div class="p-2 bg-white dark:bg-dark rounded">
                {if $item->hasBodyHtml()}
                    {$item->getBodyHtml()}
                {/if}
                {if $item->hasChildren()}
                    <ul class="list gap-1 {if $item->getChildrenAttribute('class')} {$item->getChildrenAttribute('class')}{/if}">
                        {foreach $item->getChildren() as $childItem}
                            {if $childItem->getUri()}
                                <li>
                                    <a menuItemName="{$childItem->getName()}" href="{$childItem->getUri()}"
                                        class="link d-flex align-items-center gap-2 px-2 py-2 hover:bg-primary-subtle hover:text-primary-emphasis rounded-1 group {if $childItem->isDisabled()} disabled{/if}{if $childItem->getClass()} {$childItem->getClass()}{/if}{if $childItem->isCurrent()} active{/if}">
                                        {if $childItem->hasIcon()}
                                            <i class="{$childItem->getIcon()} text-secondary group-hover:text-primary-emphasis transition"></i>
                                        {/if}
                                        <span
                                            class="d-flex align-items-center justify-content-between flex-grow-1 gap-3 text-heading group-hover:text-primary-emphasis transition">
                                            {$childItem->getLabel()}
                                            {if $childItem->hasBadge()}
                                                <span class="badge text-light bg-secondary">{$childItem->getBadge()}</span>
                                            {/if}
                                        </span>
                                    </a>
                                </li>
                            {else}
                                <li menuItemName="{$childItem->getName()}" {if $childItem->getClass()} class="{$childItem->getClass()}"
                                    {/if} id="{$childItem->getId()}">
                                    <div class="d-flex align-items-center gap-2 px-2 py-2">
                                        {if $childItem->hasBadge()}
                                            <span class="badge text-light bg-secondary">
                                                {$childItem->getBadge()}
                                            </span>
                                        {/if}
                                        <div class="d-flex align-items-center gap-2">
                                            {if $childItem->hasIcon()}<i class="{$childItem->getIcon()}"></i>{/if}
                                            {$childItem->getLabel()}
                                        </div>
                                    </div>
                                </li>
                            {/if}
                        {/foreach}
                    </ul>
                {/if}
            </div>
            {if $item->hasFooterHtml()}
                <div class="px-4 py-2">
                    {$item->getFooterHtml()}
                </div>
            {/if}
        </div>
        {if $item->getExtra('mobileSelect') and $item->hasChildren()}
            <div class="card d-block d-md-none {if $item->getClass()}{$item->getClass()}{else}bg-light{/if}"
                {if $item->getAttribute('id')} id="{$item->getAttribute('id')}" {/if}>
                <div class="card-header">
                    <h3 class="card-title">
                        {if $item->hasIcon()}<i class="{$item->getIcon()}"></i>&nbsp;{/if}
                        {$item->getLabel()}
                        {if $item->hasBadge()}&nbsp;<span class="badge float-right">{$item->getBadge()}</span>{/if}
                    </h3>
                </div>
                <div class="card-body">
                    <form role="form">
                        <select class="form-control" onchange="selectChangeNavigate(this)">
                            {foreach $item->getChildren() as $childItem}
                                <option menuItemName="{$childItem->getName()}" value="{$childItem->getUri()}"
                                    class="list-group-item list-group-item-action" {if $childItem->isCurrent()}selected="selected"
                                    {/if}>
                                    {$childItem->getLabel()}
                                    {if $childItem->hasBadge()}({$childItem->getBadge()}){/if}
                                </option>
                            {/foreach}
                        </select>
                    </form>
                </div>
                {if $item->hasFooterHtml()}
                    <div class="card-footer">
                        {$item->getFooterHtml()}
                    </div>
                {/if}
            </div>
        {/if}
    {/if}
{/foreach}