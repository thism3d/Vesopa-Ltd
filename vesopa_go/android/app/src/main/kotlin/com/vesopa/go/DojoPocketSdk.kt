package com.vesopa.go

import android.content.Context
import io.flutter.plugin.common.MethodChannel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import tech.dojo.pos.Config
import tech.dojo.pos.DojoResult
import tech.dojo.pos.Response
import tech.dojo.pos.pocket.DojoTapToPayOnPocket

/**
 * Dojo's Tap to Pay on Pocket SDK (owner, 2026-10-31;
 * docs.dojo.tech/tap-to-pay-on-pocket/sdk-integration).
 *
 * The SDK talks to the Dojo payment app on the Pocket, as the intents in
 * MainActivity do, and adds Dojo's own recovery: an answer the Pocket never
 * sent is looked up on Dojo's API. For that it needs the venue's Dojo API
 * key, which Go fetches from the back office (/api/tap/pocket-config) for
 * this signed-in device and hands over here; it is kept in memory only.
 *
 * Every request finishes its MethodChannel.Result with the same map the
 * intents give (transaction_result, transaction_id, auth_code, ...), so the
 * app reads both the same way. Every failure is a sentence a clerk can act on.
 */
object DojoPocketSdk {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var configuredKey: String? = null
    private var listening = false
    private var waiting: MethodChannel.Result? = null
    private var waitingFor: String? = null

    val ready: Boolean get() = configuredKey != null

    /** Starts the SDK with the venue's account. Safe to call again: a new key restarts it. */
    fun configure(context: Context, apiKey: String, softwareHouseId: String, resellerId: String, result: MethodChannel.Result) {
        // The SDK is Android 10+ (AndroidManifest.xml lets Go install below
        // that); older devices keep the intents, and a Pocket is never older.
        if (android.os.Build.VERSION.SDK_INT < 29) return result.error("setup", "This device's Android is too old for Dojo's Tap to Pay.", null)
        if (apiKey == configuredKey) return result.success(true)
        val r = DojoTapToPayOnPocket.initSdk(
            context.applicationContext,
            Config(apiKey = apiKey, softwareHouseId = softwareHouseId, resellerId = resellerId),
        )
        if (r.isFailure) {
            configuredKey = null
            return result.error("setup", friendly(r.errorOrNull()?.toString()), null)
        }
        configuredKey = apiKey
        listen()
        result.success(true)
    }

    /** INIT: sets the Pocket up for card payments (up to two minutes the first time). */
    fun initDojo(result: MethodChannel.Result) = ask(result, "init") { DojoTapToPayOnPocket.initDojo() }

    fun sale(amount: Int, reference: String?, result: MethodChannel.Result) {
        if (!claim(result, "sale")) return
        scope.launch {
            val r = if (reference.isNullOrEmpty()) DojoTapToPayOnPocket.sale(amount) else DojoTapToPayOnPocket.sale(amount, reference = reference)
            if (r.isFailure) fail("sale", friendly(r.errorOrNull()?.toString()))
        }
    }

    fun refund(amount: Int, result: MethodChannel.Result) {
        if (!claim(result, "refund")) return
        scope.launch {
            val r = DojoTapToPayOnPocket.refund(amount)
            if (r.isFailure) fail("refund", friendly(r.errorOrNull()?.toString()))
        }
    }

    fun lastTx(result: MethodChannel.Result) = ask(result, "last") { DojoTapToPayOnPocket.lastTx() }

    private fun ask(result: MethodChannel.Result, what: String, send: () -> DojoResult<*, *>) {
        if (!claim(result, what)) return
        val r = send()
        if (r.isFailure) fail(what, friendly(r.errorOrNull()?.toString()))
    }

    private fun claim(result: MethodChannel.Result, what: String): Boolean {
        if (waiting != null) {
            result.error("busy", "A card payment is already under way on this Pocket.", null)
            return false
        }
        waiting = result
        waitingFor = what
        return true
    }

    private fun fail(what: String, message: String) {
        if (waitingFor != what) return
        val done = waiting
        waiting = null
        waitingFor = null
        done?.error("dojo", message, null)
    }

    private fun answer(what: Set<String>, map: Map<String, Any?>) {
        if (waitingFor !in what) return
        val done = waiting
        waiting = null
        waitingFor = null
        done?.success(map)
    }

    /** Once per process, as Dojo asks: every answer arrives on one stream. */
    private fun listen() {
        if (listening) return
        listening = true
        scope.launch {
            DojoTapToPayOnPocket.responses.collect { response ->
                when (response) {
                    is Response.DojoInit -> answer(setOf("init"), mapOf(
                        "init_result" to (response.isSuccess == true),
                        "init_result_detail" to initWords(response.detail, response.isSuccess == true),
                        "terminal_id" to response.terminalId,
                    ))
                    is Response.Sale -> answer(setOf("sale"), mapOf(
                        "transaction_result" to response.transactionResult?.name,
                        "transaction_id" to response.transactionId,
                        "auth_code" to response.authCode,
                        "base_amount" to response.baseAmount,
                        "gratuity_amount" to response.gratuityAmount,
                        "card_scheme" to response.cardScheme,
                        "card_pan" to response.cardPan,
                    ))
                    is Response.Refund -> answer(setOf("refund"), mapOf(
                        "transaction_result" to response.transactionResult?.name,
                        "transaction_id" to response.transactionId,
                        "auth_code" to response.authCode,
                        "base_amount" to response.baseAmount,
                    ))
                    is Response.LastTx -> answer(setOf("last"), bundleMap(response.bundle))
                    is Response.SplitSale -> answer(setOf("sale"), bundleMap(response.bundle))
                    // The Pocket never answered and Dojo's API could not say
                    // either: the card may or may not have been charged.
                    is Response.MissingResponse -> answer(setOf("sale", "refund"), mapOf(
                        "missing" to true,
                        "message" to "The Dojo app did not say how the payment went. Check the Pocket's last payment before taking it again.",
                    ))
                    else -> {}
                }
            }
        }
    }

    private fun bundleMap(b: android.os.Bundle?): Map<String, Any?> {
        val out = HashMap<String, Any?>()
        b?.keySet()?.forEach { k ->
            @Suppress("DEPRECATION")
            out[k.removePrefix("com.dojo.extra.").lowercase()] = b.get(k)?.let { v -> if (v is Number || v is Boolean) v else v.toString() }
        }
        return out
    }

    /** INIT's codes (Dojo's guide), in words. */
    private fun initWords(detail: String?, ok: Boolean): String = when {
        ok -> detail ?: "OK"
        detail == "E1" -> "The Pocket could not start a payment session. Try again."
        detail == "A10" -> "Dojo could not set this Pocket up for payments (A10). Contact Dojo support."
        detail == "T1" -> "Setting the Pocket up timed out. Check the connection and try again."
        detail == "NO_TID" -> "Dojo has not given this Pocket a terminal number yet. Try again in a minute."
        else -> "The Pocket is not ready for card payments (${detail ?: "no reason given"})."
    }

    /**
     * An SDK error in words a clerk can act on. The SDK's error types are named
     * in its contract (tech.dojo.pos.*Error and friends); matched by name so a
     * new SDK version's extra detail never stops the sentence.
     */
    fun friendly(error: String?): String {
        val e = error ?: ""
        return when {
            e.contains("DpaNotInstalled") -> "This device has no Dojo payment app. Tap to Pay works on a Dojo Pocket."
            e.contains("DpaVersionUnsupported") -> "The Dojo payment app on this Pocket is out of date. Update it, then try again."
            e.contains("DpaSecurityFailure") -> "The Dojo app refused this device's security check. Turn off developer options and USB debugging, then try again."
            e.contains("AppInBackground") -> "Keep Vesopa Go open on the screen while taking a card."
            e.contains("InvalidAmount") -> "That amount cannot be taken on the Pocket."
            e.contains("InvalidCurrencyCode") -> "The Pocket only takes pounds."
            e.contains("NetworkError") -> "No connection to Dojo. Check the Wi-Fi or mobile data and try again."
            e.contains("ApiError") -> "Dojo turned the request down. Check the venue's Dojo settings in the back office."
            e.contains("InitSdkValidationError") || e.contains("InvalidSdkContext") ->
                "Dojo did not accept this venue's card settings. Check the Dojo key in the back office."
            e.contains("InitDojoError") -> "The Pocket could not be set up for card payments. Try again."
            e.contains("DispatchError") -> "The Dojo app did not open. Try again."
            e.contains("LastTxError") -> "The Pocket's last payment could not be read. Open the Dojo app to check it."
            else -> "The Dojo app could not take the payment. Try again, or use the card machine."
        }
    }
}
