{foreach $secondarySidebar as $item}
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
        {* Mobile Select only supports dropdown menus *}
        <div class="panel card hidden-lg hidden-md d-md-none{if $item->getClass()}{$item->getClass()}{else} panel-default{/if}"
            {if $item->getAttribute('id')} id="{$item->getAttribute('id')}" {/if}>
            {include file="orderforms/localhost_cart/sidebar-categories-selector.tpl"}
        </div>
    {/if}
{/foreach}