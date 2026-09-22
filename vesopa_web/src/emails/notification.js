/**
 * Enquiry notification email.
 *
 * The markup is the responsive table layout the PHP site used, unchanged — it is
 * hand-tuned for Outlook and is not worth re-deriving. What did change:
 *
 *  - the four notification mails shared one 27 KB template copy-pasted four
 *    times, differing only in the hero image, headline and detail rows. That is
 *    now this one function with those four things as parameters.
 *  - the 2015 purple/pink palette is now the 2025 brand green, so the mail
 *    matches the logo it is sent under.
 *  - values are HTML-escaped. The PHP version interpolated raw form input, so a
 *    name containing markup rewrote the email.
 */

const { SITE_URL } = require('../config');

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One "Label: value" line inside the tinted detail panel. */
function detailRow({ label, value }) {
  return `
                                                                                                                <tr>
                                                                                                                    <td class="text-18 a-center c-purple pb-15" style="font-size:16px; line-height:22px; font-family: Arial, sans-serif; padding-bottom: 15px;">
                                                                                                                        ${esc(label)}: <strong><span style="color:#5f7d0a;">${esc(value)}</span></strong>
                                                                                                                    </td>
                                                                                                                </tr>`;
}

/**
 * @param {object}   o
 * @param {string}   o.title      <title>, shown in some preview panes
 * @param {string}   o.heroImage  absolute URL of the illustration
 * @param {string}   o.headline   small line above the name
 * @param {string}   o.name       whoever submitted the form
 * @param {Array<{label: string, value: string}>} o.rows
 */
function renderNotification({ title, heroImage, headline, name, rows = [] }) {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
    <head>
        <!--[if gte mso 9]>
        <xml>
            <o:OfficeDocumentSettings>
            <o:AllowPNG/>
            <o:PixelsPerInch>96</o:PixelsPerInch>
            </o:OfficeDocumentSettings>
        </xml>
        <![endif]-->
        <meta http-equiv="Content-type" content="text/html; charset=utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
        <meta http-equiv="X-UA-Compatible" content="IE=edge" />
        <meta name="format-detection" content="date=no" />
        <meta name="format-detection" content="address=no" />
        <meta name="format-detection" content="telephone=no" />
        <meta name="x-apple-disable-message-reformatting" />
        <!--[if !mso]><!-->
        <link href="https://fonts.googleapis.com/css?family=PT+Sans:400,400i,700,700i&display=swap" rel="stylesheet" />
        <!--<![endif]-->
        <title>${esc(title)}</title>
        <!--[if gte mso 9]>
        <style type="text/css" media="all">
            sup { font-size: 100% !important; }
        </style>
        <![endif]-->
        <!-- body, html, table, thead, tbody, tr, td, div, a, span { font-family: Arial, sans-serif !important; } -->
        

        <style type="text/css" media="screen">
            body { padding:0 !important; margin:0 auto !important; display:block !important; min-width:100% !important; width:100% !important; background:#f3f8e2; -webkit-text-size-adjust:none }
            a { color:#5f7d0a; text-decoration:none }
            p { padding:0 !important; margin:0 !important } 
            img { margin: 0 !important; -ms-interpolation-mode: bicubic; /* Allow smoother rendering of resized image in Internet Explorer */ }

            a[x-apple-data-detectors] { color: inherit !important; text-decoration: inherit !important; font-size: inherit !important; font-family: inherit !important; font-weight: inherit !important; line-height: inherit !important; }
            
            .btn-16 a { display: block; padding: 15px 35px; text-decoration: none; }
            .btn-20 a { display: block; padding: 15px 35px; text-decoration: none; }

            .l-white a { color: #ffffff; }
            .l-black a { color: #282828; }
            .l-pink a { color: #5f7d0a; }
            .l-grey a { color: #6e6e6e; }
            .l-purple a { color: #5f7d0a; }

            .gradient { background: linear-gradient(to right, #a5c715 0%,#5f7d0a 100%); }

            .btn-secondary { border-radius: 10px; background: linear-gradient(to right, #a5c715 0%,#5f7d0a 100%); }

                    
            /* Mobile styles */
            @media only screen and (max-device-width: 480px), only screen and (max-width: 480px) {
                .mpx-10 { padding-left: 10px !important; padding-right: 10px !important; }

                .mpx-15 { padding-left: 15px !important; padding-right: 15px !important; }

                u + .body .gwfw { width:100% !important; width:100vw !important; }

                .td,
                .m-shell { width: 100% !important; min-width: 100% !important; }
                
                .mt-left { text-align: left !important; }
                .mt-center { text-align: center !important; }
                .mt-right { text-align: right !important; }
                
                .me-left { margin-right: auto !important; }
                .me-center { margin: 0 auto !important; }
                .me-right { margin-left: auto !important; }

                .mh-auto { height: auto !important; }
                .mw-auto { width: auto !important; }

                .fluid-img img { width: 100% !important; max-width: 100% !important; height: auto !important; }

                .column,
                .column-top,
                .column-dir-top { float: left !important; width: 100% !important; display: block !important; }

                .m-hide { display: none !important; width: 0 !important; height: 0 !important; font-size: 0 !important; line-height: 0 !important; min-height: 0 !important; }
                .m-block { display: block !important; }

                .mw-15 { width: 15px !important; }

                .mw-2p { width: 2% !important; }
                .mw-32p { width: 32% !important; }
                .mw-49p { width: 49% !important; }
                .mw-50p { width: 50% !important; }
                .mw-100p { width: 100% !important; }

                .mmt-0 { margin-top: 0 !important; }
            }

                </style>
    </head>
    <body class="body" style="padding:0 !important; margin:0 auto !important; display:block !important; min-width:100% !important; width:100% !important; background:#f3f8e2; -webkit-text-size-adjust:none;">
        <center>
            <table width="100%" border="0" cellspacing="0" cellpadding="0" style="margin: 0; padding: 0; width: 100%; height: 100%;" data-bgcolor="Body" bgcolor="#f3f8e2" class="gwfw">
                <tr>
                    <td style="margin: 0; padding: 0; width: 100%; height: 100%;" align="center" valign="top">
                        
                        <!-- Logo -->
                        <table width="100%" border="0" cellspacing="0" cellpadding="0" data-module="Logo">
                            <tr>
                                <td align="center" valign="top" data-bgcolor="Body" data-primary-order="1" data-primary-type="bgcolor" bgcolor="#f3f8e2">
                                    <table width="600" border="0" cellspacing="0" cellpadding="0" class="m-shell">
                                        <tr>
                                            <td class="td" style="width:600px; min-width:600px; font-size:0pt; line-height:0pt; padding:0; margin:0; font-weight:normal;">
                                                <table width="100%" border="0" cellspacing="0" cellpadding="0">
                                                    <tr>
                                                        <td class="mpx-10">
                                                            <table width="100%" border="0" cellspacing="0" cellpadding="0">
                                                                <tr>
                                                                    <td class="gradient pt-10" style="border-radius: 10px 10px 0 0; padding-top: 10px;" data-bgcolor="Logo" bgcolor="#5f7d0a">
                                                                        <table width="100%" border="0" cellspacing="0" cellpadding="0">
                                                                            <tr>
                                                                                <td class="img-center p-30 px-15" style="border-radius: 10px 10px 0 0; font-size:0pt; line-height:0pt; text-align:center; padding: 30px; padding-left: 15px; padding-right: 15px;" data-bgcolor="bgcolor" bgcolor="#ffffff">
                                                                                    <a target="_blank"><img data-crop="false" src="${SITE_URL}/assets/logo/vesopa_logo.png" style="max-width: 220px;" width="100%" border="0" alt="Vesopa EPOS Logo" /></a>
                                                                                </td>
                                                                            </tr>
                                                                        </table>
                                                                    </td>
                                                                </tr>
                                                            </table>
                                                        </td>
                                                    </tr>
                                                </table>
                                            </td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                        </table>
                        <!-- END Logo -->

                        <!-- Intro -->
                        <table width="100%" border="0" cellspacing="0" cellpadding="0" data-module="Intro">
                            <tr>
                                <td align="center" valign="top" data-bgcolor="Body" data-primary-order="1" data-primary-type="bgcolor" bgcolor="#f3f8e2">
                                    <table width="600" border="0" cellspacing="0" cellpadding="0" class="m-shell">
                                        <tr>
                                            <td class="td" style="width:600px; min-width:600px; font-size:0pt; line-height:0pt; padding:0; margin:0; font-weight:normal;">
                                                <table width="100%" border="0" cellspacing="0" cellpadding="0">
                                                    <tr>
                                                        <td class="mpx-10">
                                                            <table width="100%" border="0" cellspacing="0" cellpadding="0">
                                                                <tr>
                                                                    <td class="py-25 px-50 mpx-15" data-bgcolor="Intro" bgcolor="#ffffff" style="padding-top: 25px; padding-bottom: 25px; padding-left: 50px; padding-right: 50px;">
                                                                        <table width="100%" border="0" cellspacing="0" cellpadding="0">
                                                                            <tr>
                                                                                <td class="fluid-img img-center pb-50" style="font-size:0pt; line-height:0pt; text-align:center; padding-bottom: 50px;">
                                                                                    <img data-crop="false" src="${heroImage}" style="max-width: 300px;" width="100%" border="0" alt="" />
                                                                                </td>
                                                                            </tr>
                                                                            <tr>
                                                                                <td class="title-30 a-center pb-10" style="font-size:30px; line-height:34px; color:#282828; font-family: Arial, sans-serif; text-align:center; padding-bottom: 10px;">
                                                                                    ${esc(headline)}
                                                                                </td>
                                                                            </tr>
                                                                            <tr>
                                                                                <td class="title-36 a-center pb-35" style="font-size:36px; line-height:40px; color:#282828; font-family: Arial, sans-serif; text-align:center; padding-bottom: 35px;">
                                                                                    <strong>Request Received From "${esc(name)}"</strong>
                                                                                </td>
                                                                            </tr>
                                                                            <tr>
                                                                                <td class="py-30" style="padding-top: 30px; padding-bottom: 30px;">
                                                                                    <table width="100%" border="0" cellspacing="0" cellpadding="0">
                                                                                        <tr>
                                                                                            <td class="py-35 px-50 mpx-15" style="border-radius: 10px; padding-top: 35px; padding-bottom: 35px; padding-left: 50px; padding-right: 50px; background-color: #f3f8e2;">
                                                                                                <table width="100%" border="0" cellspacing="0" cellpadding="0">
                                                                                                    <tr>
                                                                                                        <td class="py-20" style="padding-top: 20px;">
                                                                                                            <table width="100%" border="0" cellspacing="0" cellpadding="0">${rows.map(detailRow).join('')}
                                                                                                                
                                                                                                            </table>
                                                                                                        </td>
                                                                                                    </tr>
                                                                                                </table>
                                                                                            </td>
                                                                                        </tr>
                                                                                    </table>
                                                                                </td>
                                                                            </tr>
                                                                        </table>
                                                                    </td>
                                                                </tr>
                                                            </table>
                                                        </td>
                                                    </tr>
                                                </table>
                                            </td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                        </table>
                        <!-- END Intro -->

                        <!-- Footer -->
                        <table width="100%" border="0" cellspacing="0" cellpadding="0" data-module="Footer">
                            <tr>
                                <td align="center" valign="top" data-bgcolor="Body" data-primary-order="1" data-primary-type="bgcolor" bgcolor="#f3f8e2">
                                    <table width="600" border="0" cellspacing="0" cellpadding="0" class="m-shell">
                                        <tr>
                                            <td class="td" style="width:600px; min-width:600px; font-size:0pt; line-height:0pt; padding:0; margin:0; font-weight:normal;">
                                                <table width="100%" border="0" cellspacing="0" cellpadding="0">
                                                    <tr>
                                                        <td class="mpx-10">
                                                            <table width="100%" border="0" cellspacing="0" cellpadding="0">
                                                        <tr>
                                                            <td data-bgcolor="Footer" class="p-50 mpx-15" bgcolor="#949196" style="border-radius: 0 0 10px 10px; padding: 50px;">
                                                                <table width="100%" border="0" cellspacing="0" cellpadding="0">
                                                                    <tr>
                                                                        <td align="center" class="pb-20" style="padding-bottom: 20px;">
                                                                            <!-- Socials -->
                                                                            <table border="0" cellspacing="0" cellpadding="0">
                                                                                <tr>
                                                                                    <td class="img" width="34" style="font-size:0pt; line-height:0pt; text-align:left;">
                                                                                        <a href="https://wa.me/447501928043?text=Hello%2C%20I%20am%20interested%20in%20Vesopa%20EPOS!" target="_blank"><img src="${SITE_URL}/assets/social/WhatsApp.svg.png" width="34" height="34" border="0" alt="Whatsapp" /></a>
                                                                                    </td>
                                                                                    <td class="img" width="15" style="font-size:0pt; line-height:0pt; text-align:left;"></td>
                                                                                    <td class="img" width="34" style="font-size:0pt; line-height:0pt; text-align:left;">
                                                                                        <a href="https://www.facebook.com/people/Vesopa/100027790131992/" target="_blank"><img src="${SITE_URL}/assets/social/facebook.svg.png" width="34" height="34" border="0" alt="Facebook" /></a>
                                                                                    </td>
                                                                                </tr>
                                                                            </table>
                                                                            <!-- END Socials -->
                                                                        </td>
                                                                    </tr>
                                                                    <tr>
                                                                        <td data-color="text-color-footer" data-size="text-size-footer" data-min="12" data-max="36" class="text-14 lh-24 a-center c-white l-white pb-20" style="font-size:14px; font-family: Arial, sans-serif; min-width:auto !important; line-height: 24px; text-align:center; color:#ffffff; padding-bottom: 20px;">
                                                                            Address: 1 High Street, Pontardawe, Swansea, SA8 4HU, United Kingdom
                                                                            <br />
                                                                            <a href="tel:+447501928043" target="_blank" class="link c-white" style="text-decoration:none; color:#ffffff;"><span class="link c-white" style="text-decoration:none; color:#ffffff;">+44 7501 928043</span></a> - <a href="tel:+441792316282" target="_blank" class="link c-white" style="text-decoration:none; color:#ffffff;"><span class="link c-white" style="text-decoration:none; color:#ffffff;">+44 1792 316282</span></a>
                                                                            <br />
                                                                            <a href="mailto:support@vesopa.com" target="_blank" class="link c-white" style="text-decoration:none; color:#ffffff;"><span class="link c-white" style="text-decoration:none; color:#ffffff;">support@vesopa.com</span></a> - <a href="${SITE_URL}/" target="_blank" class="link c-white" style="text-decoration:none; color:#ffffff;"><span class="link c-white" style="text-decoration:none; color:#ffffff;">vesopaepos.com</span></a>
                                                                        </td>
                                                                    </tr>
                                                                    <tr>
                                                                        <td align="center">
                                                                            <!-- Download App -->
                                                                            <table border="0" cellspacing="0" cellpadding="0">
                                                                                <tr>
                                                                                    <td class="img" width="117" style="font-size:0pt; line-height:0pt; text-align:left;">
                                                                                        <a target="_blank"><img src="${SITE_URL}/assets/icons/microsoft_store.png" width="100%" style="max-width: 100px;" border="0" alt="" /></a>
                                                                                    </td>
                                                                                    <td class="img" width="15" style="font-size:0pt; line-height:0pt; text-align:left;"></td>
                                                                                    <td class="img" width="117" style="font-size:0pt; line-height:0pt; text-align:left;">
                                                                                        <a target="_blank"><img src="${SITE_URL}/assets/icons/download_app_store.png" width="100%" style="max-width: 120px;" border="0" alt="" /></a>
                                                                                    </td>
                                                                                </tr>
                                                                            </table>
                                                                            <!-- END Download App -->
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                            </td>
                                                        </tr>
                                                    </table>													</td>
                                                    </tr>
                                                </table>
                                            </td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                        </table>
                        <!-- END Footer -->
                    </td>
                </tr>
            </table>
        </center>
    </body>
</html>`;
}

module.exports = { renderNotification, esc };
