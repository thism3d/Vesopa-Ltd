package com.vesopa.stripe_onboarding

import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.fragment.app.FragmentActivity
import com.stripe.android.PaymentConfiguration
import com.stripe.android.connect.AccountOnboardingListener
import com.stripe.android.connect.EmbeddedComponentManager
import com.stripe.android.connect.FetchClientSecretTask
import com.stripe.android.connect.StripeComponentController
import com.stripe.android.identity.IdentityVerificationSheet
import com.stripe.android.paymentsheet.PaymentSheet
import com.stripe.android.paymentsheet.PaymentSheetResult
import com.stripe.android.paymentsheet.PaymentSheetResultCallback
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * Stripe's own native screens for Vesopa Go's sign-up, on the channel
 * com.vesopa.go/stripe_onboarding (lib/stripe_onboarding.dart):
 *
 *   verifyIdentity     Stripe Identity: photo ID and a live selfie
 *   accountOnboarding  Stripe Connect: the business, its people, its bank
 *   collectCard        the card sheet, for the licence's SetupIntent
 *
 * Each answers "completed", "canceled" or "failed:<why>". Go never sees a
 * card number, an ID image or a secret key.
 *
 * Stripe's Identity and card sheets register for activity results, which
 * Android only allows while the activity is being created, so the app's
 * MainActivity calls [StripeOnboarding.onActivityCreate] in its onCreate.
 */
class StripeOnboardingPlugin : FlutterPlugin, ActivityAware, MethodChannel.MethodCallHandler {
    private var channel: MethodChannel? = null
    private var activity: FragmentActivity? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        val ch = MethodChannel(binding.binaryMessenger, "com.vesopa.go/stripe_onboarding")
        ch.setMethodCallHandler(this)
        channel = ch
        StripeOnboarding.channel = ch
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setMethodCallHandler(null)
        channel = null
        StripeOnboarding.channel = null
    }

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activity = binding.activity as? FragmentActivity
    }

    override fun onDetachedFromActivityForConfigChanges() {
        activity = null
    }

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) {
        onAttachedToActivity(binding)
    }

    override fun onDetachedFromActivity() {
        activity = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val host = activity
        if (host == null) {
            result.success("failed:Vesopa Go is not on screen.")
            return
        }
        val key = call.argument<String>("publishableKey")
        if (!key.isNullOrEmpty()) PaymentConfiguration.init(host.applicationContext, key)
        when (call.method) {
            "verifyIdentity" -> verifyIdentity(call, result)
            "collectCard" -> collectCard(call, result)
            "accountOnboarding" -> accountOnboarding(host, key, call, result)
            else -> result.notImplemented()
        }
    }

    private fun verifyIdentity(call: MethodCall, result: MethodChannel.Result) {
        val session = call.argument<String>("sessionId")
        val ephemeral = call.argument<String>("ephemeralKeySecret")
        val sheet = StripeOnboarding.identity
        if (session == null || ephemeral == null) {
            result.success("failed:No verification session.")
            return
        }
        if (sheet == null) {
            result.success("failed:Restart Vesopa Go and try again.")
            return
        }
        StripeOnboarding.waitFor(result)
        sheet.present(session, ephemeral)
    }

    private fun collectCard(call: MethodCall, result: MethodChannel.Result) {
        val secret = call.argument<String>("clientSecret")
        val sheet = StripeOnboarding.cards
        if (secret == null) {
            result.success("failed:No card session.")
            return
        }
        if (sheet == null) {
            result.success("failed:Restart Vesopa Go and try again.")
            return
        }
        StripeOnboarding.waitFor(result)
        val name = call.argument<String>("merchantName") ?: "Vesopa Software Ltd"
        val builder = PaymentSheet.Configuration.Builder(name)
        // Google Pay beside the card and Link (owner, 2026-11-18). A test key
        // pays in Google's test environment.
        if (call.argument<Boolean>("wallets") != false) {
            val test = (call.argument<String>("publishableKey") ?: "").startsWith("pk_test")
            builder.googlePay(
                PaymentSheet.GooglePayConfiguration(
                    environment = if (test) PaymentSheet.GooglePayConfiguration.Environment.Test
                    else PaymentSheet.GooglePayConfiguration.Environment.Production,
                    countryCode = "GB",
                    currencyCode = "GBP",
                ),
            )
        }
        sheet.presentWithSetupIntent(secret, builder.build())
    }

    private fun accountOnboarding(host: FragmentActivity, key: String?, call: MethodCall, result: MethodChannel.Result) {
        if (key.isNullOrEmpty()) {
            result.success("failed:No publishable key.")
            return
        }
        val manager = EmbeddedComponentManager(
            key,
            object : FetchClientSecretTask() {
                // Stripe asks for an account session when it opens and whenever
                // its own runs out; the server makes it, through Dart.
                override fun fetchClientSecret(resultCallback: ResultCallback) {
                    Handler(Looper.getMainLooper()).post {
                        val ch = StripeOnboarding.channel
                        if (ch == null) {
                            resultCallback.onResult(null)
                        } else {
                            ch.invokeMethod("fetchClientSecret", null, object : MethodChannel.Result {
                                override fun success(answer: Any?) {
                                    resultCallback.onResult(answer as? String)
                                }

                                override fun error(code: String, message: String?, details: Any?) {
                                    resultCallback.onResult(null)
                                }

                                override fun notImplemented() {
                                    resultCallback.onResult(null)
                                }
                            })
                        }
                    }
                }
            },
        )
        val controller = manager.createAccountOnboardingController(host, call.argument<String>("title"))
        var answered = false
        fun finish(answer: String) {
            if (answered) return
            answered = true
            result.success(answer)
        }
        controller.listener = object : AccountOnboardingListener {
            override fun onExit() {
                finish("completed")
                controller.dismiss()
            }

            override fun onLoadError(error: Throwable) {
                finish("failed:${error.message ?: "Stripe could not load."}")
            }
        }
        controller.onDismissListener = object : StripeComponentController.OnDismissListener {
            override fun onDismiss() {
                finish("completed")
            }
        }
        controller.show()
    }
}

/** What has to be made while MainActivity is being created. */
object StripeOnboarding {
    internal var channel: MethodChannel? = null
    internal var identity: IdentityVerificationSheet? = null
    internal var cards: PaymentSheet? = null
    private var pending: MethodChannel.Result? = null

    internal fun waitFor(result: MethodChannel.Result) {
        pending?.success("canceled")
        pending = result
    }

    private fun answer(value: String) {
        pending?.success(value)
        pending = null
    }

    /** Call from MainActivity.onCreate. */
    @JvmStatic
    fun onActivityCreate(activity: FragmentActivity) {
        EmbeddedComponentManager.onActivityCreate(activity)
        val logo = Uri.parse("android.resource://${activity.packageName}/mipmap/ic_launcher")
        identity = IdentityVerificationSheet.create(
            activity,
            IdentityVerificationSheet.Configuration(logo),
            object : IdentityVerificationSheet.IdentityVerificationCallback {
                override fun onVerificationFlowResult(verificationFlowResult: IdentityVerificationSheet.VerificationFlowResult) {
                    answer(
                        when (verificationFlowResult) {
                            is IdentityVerificationSheet.VerificationFlowResult.Completed -> "completed"
                            is IdentityVerificationSheet.VerificationFlowResult.Canceled -> "canceled"
                            is IdentityVerificationSheet.VerificationFlowResult.Failed ->
                                "failed:${verificationFlowResult.throwable.message ?: "Stripe could not check that ID."}"
                            else -> "failed:Unknown result."
                        },
                    )
                }
            },
        )
        cards = PaymentSheet.Builder(
            object : PaymentSheetResultCallback {
                override fun onPaymentSheetResult(paymentSheetResult: PaymentSheetResult) {
                    answer(
                        when (paymentSheetResult) {
                            is PaymentSheetResult.Completed -> "completed"
                            is PaymentSheetResult.Canceled -> "canceled"
                            is PaymentSheetResult.Failed -> "failed:${paymentSheetResult.error.message ?: "The card was not saved."}"
                            else -> "failed:Unknown result."
                        },
                    )
                }
            },
        ).build(activity)
    }
}
