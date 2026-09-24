"use strict";
document.addEventListener("DOMContentLoaded", function () {
	const body = document.querySelector("body");

	/**
	 * Slide Up
	 */
	const slideUp = (target, duration = 500) => {
		target.style.transitionProperty = "height, margin, padding";
		target.style.transitionDuration = duration + "ms";
		target.style.boxSizing = "border-box";
		target.style.height = target.offsetHeight + "px";
		target.offsetHeight;
		target.style.overflow = "hidden";
		target.style.height = 0;
		target.style.paddingTop = 0;
		target.style.paddingBottom = 0;
		target.style.marginTop = 0;
		target.style.marginBottom = 0;
		window.setTimeout(() => {
			target.style.display = "none";
			target.style.removeProperty("height");
			target.style.removeProperty("padding-top");
			target.style.removeProperty("padding-bottom");
			target.style.removeProperty("margin-top");
			target.style.removeProperty("margin-bottom");
			target.style.removeProperty("overflow");
			target.style.removeProperty("transition-duration");
			target.style.removeProperty("transition-property");
		}, duration);
	};

	/**
	 * Slide Down
	 */
	const slideDown = (target, duration = 500) => {
		target.style.removeProperty("display");
		let display = window.getComputedStyle(target).display;

		if (display === "none") display = "block";

		target.style.display = display;
		let height = target.offsetHeight;
		target.style.overflow = "hidden";
		target.style.height = 0;
		target.style.paddingTop = 0;
		target.style.paddingBottom = 0;
		target.style.marginTop = 0;
		target.style.marginBottom = 0;
		target.offsetHeight;
		target.style.boxSizing = "border-box";
		target.style.transitionProperty = "height, margin, padding";
		target.style.transitionDuration = duration + "ms";
		target.style.height = height + "px";
		target.style.removeProperty("padding-top");
		target.style.removeProperty("padding-bottom");
		target.style.removeProperty("margin-top");
		target.style.removeProperty("margin-bottom");
		window.setTimeout(() => {
			target.style.removeProperty("height");
			target.style.removeProperty("overflow");
			target.style.removeProperty("transition-duration");
			target.style.removeProperty("transition-property");
		}, duration);
	};

	/**
	 * Slide Toggle
	 */
	const slideToggle = (target, duration = 500) => {
		if (target.attributes.style === undefined || target.style.display === "none") {
			return slideDown(target, duration);
		} else {
			return slideUp(target, duration);
		}
	};

	/**
	 * Header Crossed
	 */
	window.addEventListener("scroll", () => {
		const primaryHeader = document.querySelector(".primary-header");
		if (primaryHeader) {
			const primaryHeaderTop = primaryHeader.offsetHeight / 3;
			const scrolled = window.scrollY;

			const primaryHeaderCrossed = () => {
				if (scrolled > primaryHeaderTop) {
					body.classList.add("primary-header-crossed");
				} else if (scrolled < primaryHeaderTop) {
					body.classList.remove("primary-header-crossed");
				} else {
					body.classList.remove("primary-header-crossed");
				}
			};
			setTimeout(primaryHeaderCrossed, 100);
		}
	});

	/**
	 * Primary Menu
	 */
	const mdScreen = "(max-width: 991px)";
	const mdScreenSize = window.matchMedia(mdScreen);
	const containSub1 = document.querySelectorAll(".has-sub-level-1 > a");
	const containSub2 = document.querySelectorAll(".has-sub-level-2 > a");
	const mdScreenSizeActive = (screen) => {
		if (screen.matches) {
			// if menu has sub
			containSub1.forEach((e) => {
				e.addEventListener("click", (el) => {
					el.preventDefault();
					el.stopPropagation();
					el.target.classList.toggle("active");
					const menuSub = e.nextElementSibling;
					if (menuSub) {
						slideToggle(menuSub, 500);
					}
				});
			});
			// if menu has 2nd sub menu
			containSub2.forEach((e) => {
				e.addEventListener("click", (el) => {
					el.preventDefault();
					el.stopPropagation();
					el.target.classList.toggle("active");
					const menuSub = e.nextElementSibling;
					if (menuSub) {
						slideToggle(menuSub, 500);
					}
				});
			});
		} else {
			containSub1.forEach((e) => {
				e.addEventListener("click", (el) => {
					el.preventDefault();
				});
			});
			containSub2.forEach((e) => {
				e.addEventListener("click", (el) => {
					el.preventDefault();
				});
			});
		}
	};
	mdScreenSize.addEventListener("change", (e) => {
		if (e.matches) {
			window.location.reload();
			mdScreenSizeActive(e);
		} else {
			mdScreenSize.removeEventListener("change", (e) => {
				mdScreenSizeActive(e);
			});
			window.location.reload();
		}
	});
	mdScreenSizeActive(mdScreenSize);

	/**
	 * Theme Settings (Dark / Light)
	 */
	const themeDropdownIcon = document.getElementById("themeDropdownIcon");
	const theme = localStorage.getItem("theme");

	// Set initial theme
	if (theme === "dark") {
		document.documentElement.setAttribute("data-bs-theme", "dark");
		updateThemeIcon("dark");
	} else {
		// Default to light theme if not set
		document.documentElement.setAttribute("data-bs-theme", "light");
		updateThemeIcon("light");
	}

	// Theme change handlers
	const selectLightTheme = document.getElementById("lightTheme");
	if (selectLightTheme) {
		selectLightTheme.addEventListener("click", function () {
			document.documentElement.setAttribute("data-bs-theme", "light");
			localStorage.setItem("theme", "light");
			updateThemeIcon("light");
		});
	}

	const selectDarkTheme = document.getElementById("darkTheme");
	if (selectDarkTheme) {
		selectDarkTheme.addEventListener("click", function () {
			document.documentElement.setAttribute("data-bs-theme", "dark");
			localStorage.setItem("theme", "dark");
			updateThemeIcon("dark");
		});
	}

	function updateThemeIcon(theme) {
		if (!themeDropdownIcon) return;

		themeDropdownIcon.setAttribute(
			"icon",
			theme === "light" ? "bi:sun" : "bi:moon-stars"
		);
	}

	/**
	 * Tooltip Init
	 */
	const tooltipTriggerList = document.querySelectorAll('[data-bs-toggle="tooltip"]');
	const tooltipList = [...tooltipTriggerList].map(
		(tooltipTriggerEl) => new bootstrap.Tooltip(tooltipTriggerEl)
	);

	/**
	 * Dropdwon Activate
	 */
	const dropdownElementList = document.querySelectorAll('[data-bs-toggle="dropdown"]');
	const dropdownList = [...dropdownElementList].map(
		(dropdownToggleEl) => new bootstrap.Dropdown(dropdownToggleEl)
	);

	/**
	 * Duplicate Scroller-X Item
	 */
	const scrollerX = document.querySelectorAll(".scroller-x");
	function scrollerXDuplication(scroller) {
		if (scroller.dataset.duplicated === "true") return;
		const scrollerInner = scroller.querySelector(".scroller-x__list");
		if (!scrollerInner) return;
		const scrollerContent = Array.from(scrollerInner.children);
		if (!scrollerContent.length) return;
		const fragment = document.createDocumentFragment();
		scrollerContent.forEach((item) => {
			const duplicateItem = item.cloneNode(true);
			fragment.appendChild(duplicateItem);
		});
		scrollerInner.appendChild(fragment);
		scroller.dataset.duplicated = "true";
	}
	scrollerX.forEach((scroller) => {
		const observer = new IntersectionObserver(
			(entries) => {
				entries.forEach((entry) => {
					if (entry.isIntersecting) {
						scrollerXDuplication(entry.target);
						observer.unobserve(entry.target);
					}
				});
			},
			{ threshold: 0 }
		);
		observer.observe(scroller);
	});

	/**
	 * Duplicate Scroller-Y Item
	 */
	const scrollerY = document.querySelectorAll(".scroller-y");

	function scrollerYDuplication(scroller) {
		if (scroller.dataset.duplicated === "true") return;
		const scrollerInner = scroller.querySelector(".scroller-y__list");
		if (!scrollerInner) return;
		const scrollerContent = Array.from(scrollerInner.children);
		if (!scrollerContent.length) return;

		const fragment = document.createDocumentFragment();
		scrollerContent.forEach((item) => {
			const duplicateItem = item.cloneNode(true);
			fragment.appendChild(duplicateItem);
		});

		scrollerInner.appendChild(fragment);
		scroller.dataset.duplicated = "true";
	}

	scrollerY.forEach((scroller) => {
		const observer = new IntersectionObserver(
			(entries) => {
				entries.forEach((entry) => {
					if (entry.isIntersecting) {
						scrollerYDuplication(entry.target);
						observer.unobserve(entry.target);
					}
				});
			},
			{ threshold: 0 }
		);
		observer.observe(scroller);
	});

	/**
	 * Preloader
	 */
	const preloader = document.querySelector(".preloader");

	// Sync with the page loading process
	window.addEventListener("load", function () {
		if (preloader) {
			setTimeout(() => {
				preloader.style.display = "none";
			}, 300);
		}
	});

	/**
	 * Sidebar Toggle
	 */
	function toggleSidebar() {
		const sidebar = document.querySelector(".doc-sidebar");
		if (sidebar) {
			sidebar.classList.toggle("active");
		}
	}
	const docSideBarToggler = document.querySelectorAll(".doc-nav-toggler");
	if (docSideBarToggler) {
		docSideBarToggler.forEach((e) => {
			e.addEventListener("click", () => toggleSidebar());
		});
	}

	/**
	 * Iterate through each tab group
	 */
	const tabGroups = document.querySelectorAll(".tab-group");
	tabGroups.forEach((group) => {
		const tabButtons = group.querySelectorAll(".tab__links");
		const tabContents = group.querySelectorAll(".tab__content");

		if (!tabButtons.length || !tabContents.length) {
			return;
		}

		// Attach event listeners to each tab button
		tabButtons.forEach((button, index) => {
			button.addEventListener("click", function () {
				// Remove active class from all buttons and contents in this group
				tabButtons.forEach((btn) => btn.classList.remove("active"));
				tabContents.forEach((content) => content.classList.remove("active"));

				// Add active class to clicked button and corresponding content
				button.classList.add("active");
				if (tabContents[index]) {
					tabContents[index].classList.add("active");
				} else {
					console.warn(`No content found for tab index ${index} in this group`);
				}
			});
		});

		// Optionally, activate the first tab by default in each group
		if (tabButtons[0]) {
			tabButtons[0].click();
		}
	});

	/**
	 * Code Snippets Expand
	 */
	const codeExpandBtn = document.querySelectorAll(".code-snippet-expand");
	if (codeExpandBtn) {
		codeExpandBtn.forEach((e) => {
			e.addEventListener("click", () => {
				const codeExpandNav = e.closest(".tab__header");
				const codeSnippetsBody = codeExpandNav.nextElementSibling;
				codeSnippetsBody.classList.toggle("code-snippet--expanded");
			});
		});
	}
});
