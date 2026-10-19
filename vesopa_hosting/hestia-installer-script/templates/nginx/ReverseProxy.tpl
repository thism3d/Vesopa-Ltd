#=========================================================================#
# Reverse proxy web domain template                                       #
# DO NOT MODIFY THIS FILE! CHANGES WILL BE LOST WHEN REBUILDING DOMAINS   #
#=========================================================================#
#
# Shows another website at this domain. Set and cleared by
# v-change-web-domain-reverse-proxy (cloud.vesopa.com, domain page), which
# writes the per-domain reverseproxy.conf included below (2026-10-19).

server {
	listen      %ip%:%proxy_port%;
	server_name %domain_idn% %alias_idn%;
	error_log   /var/log/%web_system%/domains/%domain%.error.log error;

	include %home%/%user%/conf/web/%domain%/nginx.forcessl.conf*;

	location ~ /\.(?!well-known\/|file) {
		deny all;
		return 404;
	}

	location /error/ {
		alias %home%/%user%/web/%domain%/document_errors/;
	}

	include %home%/%user%/conf/web/%domain%/reverseproxy.conf*;

	# Let's Encrypt renewals: the ACME challenge is a regex location, matched
	# ahead of the prefix location in the include above.
	include %home%/%user%/conf/web/%domain%/nginx.conf_*;
}
