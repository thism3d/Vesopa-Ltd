<!doctype html>
<html lang="en" data-bs-theme="light" data-theme="home-2">

<head>
    <meta charset="{$charset}" />
    <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
    <title>{if $kbarticle.title}{$kbarticle.title} - {/if}{$pagetitle} - {$companyname}</title>
    {include file="$template/includes/common/head.tpl"}
    {$headoutput}
</head>
{if $templatefile == 'homepage'}
    {assign var="additionalClasses" value="bg-light dark:bg-dark-subtle"}
{/if}

<body class="{$additionalClasses}" data-phone-cc-input="{$phoneNumberInputStyle}">

    {if $captcha}{$captcha->getMarkup()}{/if}
    {$headeroutput}

    {* Top Header *}
    {if $loggedin}
        <div class="topbar bg-dark-emphasis dark:bg-dark-subtle">
            <div class="container">
                <div class="row g-4 align-items-center">
                    <div class="col-6">
                        <button type="button"
                            class="btn btn-sm align-items-center text-light text-opacity-70 hover:text-opacity-100 px-1"
                            data-toggle="popover" id="accountNotifications" data-placement="bottom">
                            <i class="far fa-flag"></i>
                            {if count($clientAlerts) > 0}
                                {count($clientAlerts)}
                                <span class="d-none d-sm-inline">{lang key='notifications'}</span>
                            {else}
                                <span class="d-sm-none">0</span>
                                <span class="d-none d-sm-inline">{lang key='nonotifications'}</span>
                            {/if}
                        </button>
                        <div id="accountNotificationsContent" class="w-hidden">
                            <ul class="client-alerts">
                                {foreach $clientAlerts as $alert}
                                    <li>
                                        <a href="{$alert->getLink()}">
                                            <i
                                                class="fas fa-fw fa-{if $alert->getSeverity() == 'danger'}exclamation-circle{elseif $alert->getSeverity() == 'warning'}exclamation-triangle{elseif $alert->getSeverity() == 'info'}info-circle{else}check-circle{/if}"></i>
                                            <div class="message">{$alert->getMessage()}</div>
                                        </a>
                                    </li>
                                {foreachelse}
                                    <li class="none">
                                        {lang key='notificationsnone'}
                                    </li>
                                {/foreach}
                            </ul>
                        </div>
                    </div>

                    <div class="col-6">
                        <ul class="list list-row flex-wrap gap-2 align-items-center justify-content-end">
                            <li class="d-none d-md-inline">
                                <span class="d-block fs-14 text-light">{lang key='loggedInAs'}:</span>
                            </li>
                            <li>
                                <a href="{$WEB_ROOT}/clientarea.php?action=details"
                                    class="btn btn-sm btn-link px-2 text-decoration-none text-light text-opacity-70 hover:text-opacity-100">
                                    {if $client.companyname}
                                        {$client.companyname}
                                    {else}
                                        {$client.fullName}
                                    {/if}
                                </a>
                            </li>
                            <li>
                                <a href="{routePath('user-accounts')}"
                                    class="btn btn-sm px-1 text-light text-opacity-70 hover:text-opacity-100"
                                    data-toggle="tooltip" data-placement="bottom" title="Switch Account">
                                    <i class="fad fa-random"></i>
                                </a>
                                {if $adminMasqueradingAsClient || $adminLoggedIn}
                                    <a href="{$WEB_ROOT}/logout.php?returntoadmin=1" class="btn btn-return-to-admin"
                                        data-toggle="tooltip" data-placement="bottom"
                                        title="{if $adminMasqueradingAsClient}{lang key='adminmasqueradingasclient'} {lang key='logoutandreturntoadminarea'}{else}{lang key='adminloggedin'} {lang key='returntoadminarea'}{/if}">
                                        <i class="fas fa-redo-alt"></i>
                                        <span class="d-none d-md-inline-block">{lang key="admin.returnToAdmin"}</span>
                                    </a>
                                {/if}
                            </li>
                        </ul>
                    </div>
                </div>
            </div>
        </div>
    {/if}
    {* Top Header End *}

    {* Header *}
    <header id="header"
        class="navbar navbar-expand-lg primary-header primary-header--dark-alt primary-header--sticky top-0 primary-header-crossed:top-0 primary-header-crossed:full-dark">
        <div class="container align-items-lg-center ">
            {if $logo}
                <a class="logo d-inline-block text-decoration-none fw-semibold text-light transition" href="{$WEB_ROOT}/index.php">
                    <img src="{$logo}" alt="{$companyname}" class="logo__img">
                </a>
            {else}
                <a class="text-decoration-none fw-semibold text-light transition" href="{$WEB_ROOT}/index.php">
                    {$companyname}
                </a>
            {/if}
            <button class="navbar-toggler border-0" type="button" data-bs-toggle="collapse" data-bs-target="#navbar0"
                aria-controls="navbar0" aria-expanded="false" aria-label="Toggle navigation">
                <iconify-icon icon="solar:hamburger-menu-line-duotone"></iconify-icon>
            </button>
            <nav class="collapse navbar-collapse" id="navbar0">
                <ul class="navbar-nav flex-grow-1 justify-content-center mx-lg-4 mb-2 mb-lg-0">
                    {include file="$template/includes/common/navbar.tpl" navbar=$primaryNavbar}
                </ul>
                <div class="d-flex align-items-center gap-4 ms-lg-auto">
                    <a class="nav-link fs-14" href="#">RTL</a>
                    <button type="button" class="btn btn-icon btn-sm nav-link" data-bs-toggle="modal"
                        data-bs-target="#searchModal">
                        <iconify-icon icon="bi:search"></iconify-icon>
                    </button>
                    <div class="dropdown dropdown-modifier dropdown-xsm">
                        <button class="btn dropdown-toggle px-4 px-lg-0 fs-14 border-0 align-items-center gap-1"
                            type="button" data-bs-toggle="dropdown" aria-haspopup="true" aria-expanded="false">
                            <iconify-icon id="themeDropdownIcon" icon="bi:sun"></iconify-icon>
                        </button>
                        <ul class="dropdown-menu dropdown-menu-end dropdown-menu-light mw-unset">
                            <li>
                                <button type="button" class="dropdown-item d-flex align-items-center gap-2 fs-14"
                                    id="lightTheme">
                                    <span class="d-block flex-shrink-0">
                                        <iconify-icon icon="bi:sun"></iconify-icon>
                                    </span>
                                    <span class="d-block flex-grow-1"> Light </span>
                                </button>
                            </li>
                            <li>
                                <button type="button" class="dropdown-item d-flex align-items-center gap-2 fs-14"
                                    id="darkTheme">
                                    <span class="d-block flex-shrink-0">
                                        <iconify-icon icon="bi:moon-stars"></iconify-icon>
                                    </span>
                                    <span class="d-block flex-grow-1"> Dark </span>
                                </button>
                            </li>
                        </ul>
                    </div>
                    <a href="{$WEB_ROOT}/cart.php?a=view"
                        class="btn btn-icon rounded-circle bg-primary-subtle-rgb dark:bg-primary-emphasis-rgb bg-opacity-20 dark:bg-opacity-20 text-light position-relative z-1 fs-18">
                        <iconify-icon icon="bi:cart3"></iconify-icon>
                        <span id="cartItemCount"
                            class="d-grid place-content-center w-5 h-5 bg-secondary lh-1 fs-10 rounded-circle position-absolute top-0 start-100 translate-middle">{$cartitemcount}</span>
                        <span class="sr-only">{lang key="carttitle"}</span>
                    </a>

                    <div class="dropdown dropdown-modifier dropdown-md">
                        {foreach $secondaryNavbar as $item}
                            <button type="button"
                                class="btn btn-icon rounded-circle bg-primary-subtle-rgb dark:bg-primary-emphasis-rgb bg-opacity-20 dark:bg-opacity-20 text-light position-relative z-1 p-0 w-10 h-10"
                                data-bs-toggle="dropdown" aria-haspopup="true" aria-expanded="false">
                                {if $item->hasIcon()}
                                    <i class="{$item->getIcon()} fs-16 lh-1"></i>
                                {else}
                                    <i class="fa fa-user fs-16 lh-1"></i>
                                {/if}
                            </button>
                            <ul class="dropdown-menu dropdown-menu-lg-end dropdown-menu-light mw-unset">
                                <li>
                                    <a href="{$item->getUri()}"
                                        class="link dropdown-item bg-primary-subtle text-primary-emphasis">
                                        {$item->getLabel()}
                                    </a>
                                </li>
                                <li>
                                    <hr class="dropdown-divider m-0">
                                </li>
                                {foreach $item->getChildren() as $childItem}
                                    {if $childItem->getClass() && in_array($childItem->getClass(), ['dropdown-divider', 'nav-divider'])}
                                        <li>
                                            <hr class="dropdown-divider m-0">
                                        </li>
                                    {else}
                                        <li menuItemName="{$childItem->getName()}" {if $childItem->getClass()}
                                            class="{$childItem->getClass()}" {/if} id="{$childItem->getId()}">
                                            <a href="{$childItem->getUri()}"
                                                class="dropdown-item d-flex align-items-center gap-2 fs-14"
                                                {if $childItem->getAttribute('target')}
                                                target="{$childItem->getAttribute('target')}" {/if}>
                                                {if $childItem->hasIcon()}
                                                    <span class="d-block flex-shrink-0">
                                                        <i class="{$childItem->getIcon()}"></i>
                                                    </span>
                                                {/if}
                                                <span class="d-block flex-grow-1">
                                                    {$childItem->getLabel()}
                                                    {if $childItem->hasBadge()}&nbsp;
                                                        <span class="badge">{$childItem->getBadge()}</span>
                                                    {/if}
                                                </span>
                                            </a>
                                        </li>
                                    {/if}
                                {/foreach}
                            </ul>
                        {/foreach}
                    </div>
                </div>
            </nav>
        </div>
    </header>
    {* Header End *}

    {include file="$template/includes/network-issues-notifications.tpl"}

    {* Breadcrumb *}
    {if $templatefile !== 'homepage'}
        <nav class="master-breadcrumb bg-primary-subtle dark:bg-dark-subtle" aria-label="breadcrumb">
            <div class="container">
                {include file="$template/includes/common/breadcrumb.tpl"}
            </div>
        </nav>
    {/if}
    {* Breadcrumb End *}

    {include file="$template/includes/validateuser.tpl"}
    {include file="$template/includes/verifyemail.tpl"}

    {* Hero *}
    {if $templatefile == 'homepage'}
        {include file="$template/includes/sections/hero.tpl"}
    {/if}
    {* Hero End *}

    <section id="main-body">
        <div class="{if !$skipMainBodyContainer && $templatefile !== 'homepage'}container{else}container-fluid{/if}">
            <div class="row g-4">

                {if !$inShoppingCart && ($primarySidebar->hasChildren() || $secondarySidebar->hasChildren())}
                    <div class="col-lg-4 col-xl-3">
                        <div class="sidebar">
                            {include file="$template/includes/common/sidebar.tpl" sidebar=$primarySidebar}
                        </div>
                        {if !$inShoppingCart && $secondarySidebar->hasChildren()}
                            <div class="d-none d-lg-block sidebar">
                                {include file="$template/includes/common/sidebar.tpl" sidebar=$secondarySidebar}
                            </div>
                        {/if}
                    </div>
                {/if}
                <div
class="{if !$inShoppingCart && ($primarySidebar->hasChildren() || $secondarySidebar->hasChildren())}col-lg-8 col-xl-9{else}col-12{/if} primary-content">