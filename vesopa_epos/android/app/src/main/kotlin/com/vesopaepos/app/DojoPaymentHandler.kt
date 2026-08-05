package com.vesopaepos.app

import android.app.Activity
import android.content.Intent
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * Bridges the Flutter `vesopa/dojo` MethodChannel to Dojo's native drop-in UI
 * SDK (`tech.dojo.pay:uisdk`).
 *
 * Reflection, not a direct import: the Dojo SDK sits behind a credentialed
 * Maven repo (see android/build.gradle.kts) and is only on the classpath when
 * `dojo.sdk.enabled=true`. Calling it reflectively means MainActivity compiles
 * and the app builds — and runs — with or without the SDK. When the SDK is
 * absent, `startPayment` reports the channel as unavailable and the Dart side
 * (`NativeDojoProvider`) falls back to the REST card flow.
 *
 * When the SDK IS present this drives the Activity-based flow from Dojo's
 * SDK source (`DojoSDKDropInUI`):
 *
 *   DojoSDKDropInUI.dojoSDKDebugConfig = DojoSDKDebugConfig(isSandboxIntent = sandbox)
 *   DojoSDKDropInUI.startUIPaymentFlowForResult(activity, DojoPaymentFlowParams(id, secret))
 *   // → result arrives in Activity.onActivityResult →
 *   DojoSDKDropInUI.parseUIPaymentFlowResult(requestCode, resultCode, data): DojoPaymentResult?
 *
 * The intent (paymentId + clientSecret) is created on the Dart/REST side and
 * passed in; this handler only presents the card UI and returns the integer
 * `DojoPaymentResult.code`.
 */
object DojoPaymentHandler {
    const val CHANNEL = "vesopa/dojo"

    // The in-flight payment's reply, held across the Activity result round-trip.
    private var pending: MethodChannel.Result? = null
    private var activityRef: Activity? = null

    fun register(activity: Activity, messenger: io.flutter.plugin.common.BinaryMessenger) {
        activityRef = activity
        MethodChannel(messenger, CHANNEL).setMethodCallHandler { call, result ->
            handle(activity, call, result)
        }
    }

    private fun handle(activity: Activity, call: MethodCall, result: MethodChannel.Result) {
        if (call.method != "startPayment") {
            result.notImplemented()
            return
        }

        val paymentId = call.argument<String>("paymentId")
        val clientSecret = call.argument<String>("clientSecret")
        val sandbox = call.argument<Boolean>("sandbox") ?: true

        // Google Pay. Absent unless the venue has entered its wallet merchant
        // details, and the drop-in hides the button when it is not passed.
        val walletMerchantName = call.argument<String>("walletMerchantName")
        val walletMerchantId = call.argument<String>("walletMerchantId") ?: ""
        val walletGatewayMerchantId = call.argument<String>("walletGatewayMerchantId")

        if (paymentId == null || clientSecret == null) {
            result.error("bad_args", "paymentId and clientSecret are required", null)
            return
        }

        if (!sdkAvailable()) {
            // Signal "no native SDK here" so Dart falls back to REST.
            result.notImplemented()
            return
        }

        try {
            pending = result
            startNativePayment(
                activity,
                paymentId,
                clientSecret,
                sandbox,
                walletMerchantName,
                walletMerchantId,
                walletGatewayMerchantId,
            )
        } catch (t: Throwable) {
            pending = null
            result.error("dojo_error", t.message ?: "Dojo SDK error", null)
        }
    }

    private fun sdkAvailable(): Boolean = try {
        Class.forName("tech.dojo.pay.uisdk.DojoSDKDropInUI")
        true
    } catch (_: ClassNotFoundException) {
        false
    }

    private fun startNativePayment(
        activity: Activity,
        paymentId: String,
        clientSecret: String,
        sandbox: Boolean,
        walletMerchantName: String?,
        walletMerchantId: String,
        walletGatewayMerchantId: String?,
    ) {
        val dropInClass = Class.forName("tech.dojo.pay.uisdk.DojoSDKDropInUI")
        val dropIn = dropInClass.getField("INSTANCE").get(null)

        // dojoSDKDebugConfig = DojoSDKDebugConfig(null, sandbox, sandbox).
        // The third argument is `isSandboxWallet`, which is what puts Google Pay
        // into WalletConstants.ENVIRONMENT_TEST — without it a sandbox till
        // would ask Google for a real, chargeable card.
        val debugConfigClass =
            Class.forName("tech.dojo.pay.sdk.card.entities.DojoSDKDebugConfig")
        val debugConfig = debugConfigClass
            .getConstructor(
                Class.forName("tech.dojo.pay.sdk.card.entities.DojoSDKURLConfig"),
                Boolean::class.javaPrimitiveType,
                Boolean::class.javaPrimitiveType,
            )
            .newInstance(null, sandbox, sandbox)
        dropInClass.getMethod("setDojoSDKDebugConfig", debugConfigClass)
            .invoke(dropIn, debugConfig)

        val gPayConfigClass =
            Class.forName("tech.dojo.pay.sdk.card.entities.DojoGPayConfig")
        val gPayConfig = buildGPayConfig(
            gPayConfigClass,
            walletMerchantName,
            walletMerchantId,
            walletGatewayMerchantId,
        )

        // DojoPaymentFlowParams(paymentId, clientSecret, gPayConfig, paymentType).
        // The full four-argument constructor is used rather than an overload so
        // the wallet can be passed; a null gPayConfig is exactly what the
        // shorter constructor would have defaulted to, and the drop-in then
        // simply does not offer Google Pay.
        val paymentTypeClass =
            Class.forName("tech.dojo.pay.uisdk.entities.DojoPaymentType")
        val paymentCard = paymentTypeClass
            .getMethod("valueOf", String::class.java)
            .invoke(null, "PAYMENT_CARD")

        val paramsClass =
            Class.forName("tech.dojo.pay.uisdk.entities.DojoPaymentFlowParams")
        val params = paramsClass
            .getConstructor(
                String::class.java,
                String::class.java,
                gPayConfigClass,
                paymentTypeClass,
            )
            .newInstance(paymentId, clientSecret, gPayConfig, paymentCard)

        // startUIPaymentFlowForResult(activity, params) → onActivityResult.
        dropInClass
            .getMethod("startUIPaymentFlowForResult", Activity::class.java, paramsClass)
            .invoke(dropIn, activity, params)
    }

    /**
     * Build Dojo's Google Pay config, or null when the venue has not set up a
     * wallet.
     *
     * The gateway merchant id is the deciding field: it is what Google encrypts
     * the card token against, so without it the sheet would open and then fail
     * at authorisation — worse than never showing the button.
     *
     * DojoGPayConfig(collectShipping, allowedCountryCodesForShipping,
     *   collectBilling, collectEmailAddress, collectPhoneNumber, merchantName,
     *   merchantId, gatewayMerchantId, allowedCardNetworks)
     *
     * Nothing extra is collected: a till already has the customer in front of
     * it, and asking Google for a billing address slows the queue for data the
     * venue does not use.
     */
    private fun buildGPayConfig(
        gPayConfigClass: Class<*>,
        merchantName: String?,
        merchantId: String,
        gatewayMerchantId: String?,
    ): Any? {
        if (merchantName.isNullOrBlank() || gatewayMerchantId.isNullOrBlank()) {
            return null
        }

        val schemesClass =
            Class.forName("tech.dojo.pay.sdk.card.entities.CardsSchemes")
        val networks = listOf("VISA", "MASTERCARD", "MAESTRO", "AMEX").map {
            schemesClass.getMethod("valueOf", String::class.java).invoke(null, it)
        }

        return gPayConfigClass
            .getConstructor(
                Boolean::class.javaPrimitiveType,
                List::class.java,
                Boolean::class.javaPrimitiveType,
                Boolean::class.javaPrimitiveType,
                Boolean::class.javaPrimitiveType,
                String::class.java,
                String::class.java,
                String::class.java,
                List::class.java,
            )
            .newInstance(
                false, null, false, false, false,
                merchantName, merchantId, gatewayMerchantId, networks,
            )
    }

    /** Called from MainActivity.onActivityResult. Parses the SDK result and
        replies to the awaiting Flutter call with the DojoPaymentResult code. */
    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        val reply = pending ?: return
        try {
            val dropInClass = Class.forName("tech.dojo.pay.uisdk.DojoSDKDropInUI")
            val dropIn = dropInClass.getField("INSTANCE").get(null)
            val res = dropInClass
                .getMethod(
                    "parseUIPaymentFlowResult",
                    Int::class.javaPrimitiveType,
                    Int::class.javaPrimitiveType,
                    Intent::class.java,
                )
                .invoke(dropIn, requestCode, resultCode, data)
            if (res == null) return // not our request code; keep waiting

            val code = res.javaClass.getMethod("getCode").invoke(res) as Int
            reply.success(code)
        } catch (t: Throwable) {
            reply.error("dojo_error", t.message ?: "Dojo result error", null)
        } finally {
            pending = null
        }
    }
}
