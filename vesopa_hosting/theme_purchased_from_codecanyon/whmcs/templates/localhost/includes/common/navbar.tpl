{foreach $navbar as $item}
    <li menuItemName="{$item->getName()}"
        class="nav-item navigation-1 {if $item@first} no-collapse{/if}{if $item->hasChildren()} has-sub-level-1{/if}{if $item->getClass()} {$item->getClass()}{/if}"
        id="{$item->getId()}">
        <a class="nav-link" {if $item->hasChildren()}href="#" 
        {else}href="{$item->getUri()}"
                {/if}{if $item->getAttribute('target')} target="{$item->getAttribute('target')}" {/if}>
                {if $item->hasIcon()}<i class="{$item->getIcon()}"></i>&nbsp;{/if}
                {$item->getLabel()}
                {if $item->hasBadge()}&nbsp;<span class="badge">{$item->getBadge()}</span>{/if}
            </a>
            {if $item->hasChildren()}
                <ul class="navigation-1__menu">
                    {foreach $item->getChildren() as $childItem}
                        <li menuItemName="{$childItem->getName()}"
                            class="navigation-1__menu-list {if $childItem->getClass()} {$childItem->getClass()}{/if}"
                            id="{$childItem->getId()}">
                            <a href="{$childItem->getUri()}" class="link navigation-1__menu-link"
                                {if $childItem->getAttribute('target')} target="{$childItem->getAttribute('target')}" {/if}>
                                {if $childItem->hasIcon()}<i class="{$childItem->getIcon()}"></i>&nbsp;{/if}
                                {$childItem->getLabel()}
                                {if $childItem->hasBadge()}&nbsp;<span class="badge">{$childItem->getBadge()}</span>{/if}
                            </a>
                        </li>
                    {/foreach}
                </ul>
            {/if}
        </li>
    {/foreach}