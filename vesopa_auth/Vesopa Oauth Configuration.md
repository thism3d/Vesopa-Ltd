# Apple iCloud SSO
App ID:
Platform: iOS, iPadOS, macOS, tvOS, watchOS, visionOS
App ID Prefix: G238FR2ZC9 (Team ID)
Description: Vesopa
Bundle ID: com.vesopa (explicit)





Service ID:
Description: Vesopa Apple Auth
Identifier: com.vesopa.auth
Enabled: Sign In with Apple
Primary App ID: 1 App ID: Vesopa (G238FR2ZC9.com.vesopa)
Domains and Subdomains: auth.vesopa.com
Return URL: https://auth.vesopa.com/auth/apple/callback

Web Authentication Configuration: Information:
Use Sign in with Apple to let your users sign in to your app's accompanying website with their Apple Account. To configure web authentication, group your website with the existing primary App ID that's enabled for Sign in with Apple.
Website URLs: Provide your web domain and return URLs that will support Sign in with Apple. Your website must support TLS 1.2 or higher. All Return URLs must be registered with the https:// protocol included in the URI string. After registering new website URLs, confirm the list you’d like to add to this Services ID and click Done. To complete the process, click Continue, then click Save.






Key Details:
Name: Vesopa Auth Key
Key ID: UX5DVJ787G
Created by: Meirion Davies on 2026/09/08 16:09 pm
Name: Sign In with Apple	Configuration: G238FR2ZC9.com.vesopa
Key: AuthKey_UX5DVJ787G.p8

	

Sign in with Apple for Email Communication: Information:
In order to contact users that use Apple’s private email relay service, you must register email sources that your organization will use for communication. Domains and domains associated with email addresses must comply with Sender Policy Framework or DKIM standards.

Email Sources:
                        Type	            Status
vesopa.com              Domain              SPF (Verified)
no-reply@vesopa.com     Email address       SPF (Verified)
account@vesopa.com      Email address       SPF (Verified)



















# Google Auth Information
Your non-sensitive scopes
API
Scope
User-facing description
.../auth/userinfo.email	See your primary Google Account email address	
.../auth/userinfo.profile	See your personal info, including any personal info you've made publicly available	
openid	Associate you with your personal info on Google	

Client Secret: client_secret_2_561180189171-na3jtfi2d08052cah8er327k58rvbg5u.apps.googleusercontent.com.json





















# Microsoft Account Authentication Information
Endpoints
Authority URL (Accounts in this organizational directory only)
https://login.microsoftonline.com/common
Authority URL (Accounts in any organizational directory)
https://login.microsoftonline.com/organizations
Authority URL (Accounts in any organizational directory and personal Microsoft accounts)
https://login.microsoftonline.com/common
Authority URL (Personal Microsoft accounts only)
https://login.microsoftonline.com/consumers
OAuth 2.0 authorization endpoint (v2)
https://login.microsoftonline.com/common/oauth2/v2.0/authorize
OAuth 2.0 token endpoint (v2)
https://login.microsoftonline.com/common/oauth2/v2.0/token
OAuth 2.0 authorization endpoint (v1)
https://login.microsoftonline.com/common/oauth2/authorize
OAuth 2.0 token endpoint (v1)
https://login.microsoftonline.com/common/oauth2/token
SAML-P sign-on endpoint
https://login.microsoftonline.com/eef68809-c708-46fa-bf22-8eab9cd3952b/saml2
SAML-P sign-out endpoint
https://login.microsoftonline.com/eef68809-c708-46fa-bf22-8eab9cd3952b/saml2
WS-Federation sign-on endpoint
https://login.microsoftonline.com/eef68809-c708-46fa-bf22-8eab9cd3952b/wsfed
Federation metadata document
https://login.microsoftonline.com/eef68809-c708-46fa-bf22-8eab9cd3952b/federationmetadata/2007-06/federationmetadata.xml
OpenID Connect metadata document
https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration
Microsoft Graph API endpoint
https://graph.microsoft.com


Display name
:
Vesopa
Application (client) ID
:
335a71ee-f200-4cb3-9965-dafc3ab0e01b
Object ID
:
c48061b8-1d0c-48a1-8f95-bda721afae7c
Directory (tenant) ID
:
eef68809-c708-46fa-bf22-8eab9cd3952b
Supported account types
:
All Microsoft account users
Client credentials
:
0 certificate, 1 secret
Redirect URIs
:
0 web, 1 spa, 1 public client
Application ID URI
:
api://vesopa
Managed application in local directory
:
Vesopa
State
:
Activated






Anothe I have
Properties

Name
 VesopaEPOS
Application ID
6ef0452e-04ea-4f22-b580-6a93534978f6
Object ID 
e2a4ac6f-68a5-4860-a652-19d3fc93518e


# Github Now

About
Owned by: @thism3d

App ID: 4876005

Using your App ID to get installation tokens? You can now use your Client ID instead.

Client ID: Iv23liLFFlwUqny92CKX

GitHub Apps can use OAuth credentials to identify users. Learn more about identifying users by reading our integration developer documentation.

Public link
https://github.com/apps/vesopa
Client secrets
You need a client secret to authenticate as the application to the API.

Basic information
GitHub App name
Vesopa
The name of your GitHub App.

 Markdown supported
Write
Preview
<p align="center"> <img src="https://vesopasoftware.com/assets/apple-touch-icon.png" alt="Vesopa" width="120" height="120" style="border-radius: 50%;"> </p>

<h1 align="center">Vesopa</h1>

<p align="center"> <strong>Sign in securely with Vesopa.</strong> </p>

<p align="center"> Vesopa provides a unified identity and authentication experience across Vesopa products and services. </p>
Homepage URL
https://auth.vesopa.com
The full URL to your GitHub App’s website.

Identifying and authorizing users
The URIs to redirect to after a user authorizes your application. You may add up to 10 redirect URIs. Wildcard matching allows tokens to be sent to all subdomains and additional paths of the redirect URI. Only enable this if you are sure you have control over all possible matches. Learn more about secure use of redirect URIs.
Redirect URI
https://auth.vesopa.com/auth/github/callback
 Allow wildcard matching
 Request user authorization (OAuth) during installation
Requests that the installing user grants access to their identity during installation of your App.

 Enable Device Flow
Allow this GitHub App to authorize users via the device flow.

Post installation
Setup URL (optional)
Users will be redirected to this URL after installing your GitHub App to complete additional setup.

 Redirect on update
Redirect users to the 'Setup URL' after installations are updated (E.g. repositories added/removed).

Webhook

Active
We will deliver event details when this hook is triggered.
Webhook URL
Events will POST to this URL with a webhook.

Secret
Set a secret to secure your webhooks.

 
Display information
Drag & drop

You can also drag and drop a picture from your computer.


Marketplace
List your GitHub App in the GitHub Marketplace so that other users can discover it.

List in Marketplace
Private keys: vesopa.2026-09-08.private-key.pem


