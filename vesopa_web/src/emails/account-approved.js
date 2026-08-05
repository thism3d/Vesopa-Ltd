/**
 * Sent to a business when an admin approves their demo request, which is the
 * moment their back-office login starts working.
 *
 * Same layout as the PHP original; palette moved to the 2025 brand green and
 * image URLs now follow SITE_URL rather than being pinned to the old domain.
 *
 * The port of this file was left half-finished: the credential lines still
 * carried PHP's own string interpolation, so every approved business was
 * emailed those literal strings instead of a login, and the template ended in a
 * stray `require_once '../mail.php` whose backtick closed the JS template
 * literal early — the tail of the PHP file was being mailed out as visible text
 * at the bottom of the message. Both are gone; the values are now parameters.
 */

const { SITE_URL, BACKOFFICE_URL } = require('../config');
const { esc } = require('./notification');

/**
 * @param {object} o
 * @param {string} o.email    the address that is now a back-office login
 * @param {string} o.password the plaintext password the admin just set, which
 *                            is the only moment it exists — the column holds a
 *                            bcrypt hash
 */
function renderAccountApproved({ email, password }) {
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
		<title>Account Approved</title>
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
																					<img data-crop="false" src="${SITE_URL}/assets/email/Approved.png" style="max-width: 300px;" width="100%" border="0" alt="" />
																				</td>
																			</tr>
																			<tr>
																				<td data-color="title-color-36" data-size="title-size-36" data-min="12" data-max="36" class="title-36 a-center pb-15" style="font-size:36px; line-height:40px; color:#282828; font-family: Arial, sans-serif; min-width:auto !important; text-align:center; padding-bottom: 15px;">
																					<strong>Account Approved</strong>
																				</td>
																			</tr>
																			<tr>
																				<td data-color="text-color-16" data-size="text-size-16" data-min="12" data-max="36" class="text-16 lh-26 a-center pb-25" style="font-size:16px; color:#6e6e6e; font-family: Arial, sans-serif; min-width:auto !important; line-height: 26px; text-align:center; padding-bottom: 25px;">
																					Your account has been approved. You can now login to your account and start using our services.<br><br>
																					<strong>Login Credentials</strong>
																					<hr>
																					<strong>Email:</strong> ${esc(email)}<br>
																					<strong>Password:</strong> ${esc(password)}<br>
																					<br>
																					<br>
																					<strong>Thank you for choosing Vesopa EPOS.</strong>
																					<br>
                                                                                    <br>
																					<i>You will be able to use the BackOffice now.</i>
																				</td>
																			</tr>
																			<tr>
																				<td align="center">
																					<!-- Button -->
																					<table border="0" cellspacing="0" cellpadding="0" style="min-width: 200px;">
																						<tr>
																							<td data-bgcolor="btn-color" data-color="btn-color" data-border-color="" data-border-size="btn-border" data-border-size-min="0" data-border-size-max="3" data-border-color="btn-border" data-size="btn-size" data-min="12" data-max="36" class="btn-16 c-white l-white" bgcolor="#5f7d0a" style="font-size:16px; line-height:20px; mso-padding-alt:15px 35px; font-family: Arial, sans-serif; text-align:center; font-weight:bold; text-transform:uppercase; border-radius:25px; min-width:auto !important; color:#ffffff;">
																								<a href="${BACKOFFICE_URL}" target="_blank" class="link c-white" style="display: block; padding: 15px 35px; text-decoration:none; color:#ffffff;">
																									<span class="link c-white" style="text-decoration:none; color:#ffffff;">Back Office</span>
																								</a>
																							</td>
																						</tr>
																					</table>
																					<!-- END Button -->
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

module.exports = { renderAccountApproved };
