{include file="$template/includes/sections/about.tpl"}
{if !empty($allPricingGroups) || !empty($productGroups)}
    {foreach from=$allPricingGroups item=$group}
        {if $group.groupName === "Web Hosting"}
            {include file="$template/includes/sections/pricing.tpl"}
        {/if}
    {/foreach}
{/if}
{if $registerdomainenabled || $transferdomainenabled}
    {include file="$template/includes/sections/service.tpl"}
{/if}

{include file="$template/includes/sections/testimonials.tpl"}
{include file="$template/includes/sections/cta.tpl"}