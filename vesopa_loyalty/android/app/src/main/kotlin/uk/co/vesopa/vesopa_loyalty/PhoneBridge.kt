package uk.co.vesopa.vesopa_loyalty

import android.app.Activity
import com.google.firebase.FirebaseException
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.PhoneAuthCredential
import com.google.firebase.auth.PhoneAuthOptions
import com.google.firebase.auth.PhoneAuthProvider
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.TimeUnit

/**
 * Proving a mobile number with Firebase Authentication (2026-10-13).
 *
 * Firebase texts the code, to any country, and answers a Firebase ID token
 * whose phone_number is the proved number; the server checks that token
 * (vesopa_server/src/firebase_phone.js). The texts used to go through
 * Postcoder, which reaches UK mobiles only.
 *
 * Two calls, from lib/platform/firebase_phone_io.dart:
 *   start(phone)            -> {"verification": id} once the text is sent, or
 *                              {"token": idToken} when Android proved the number
 *                              by itself (instant verification / auto-read)
 *   confirm(verification,code) -> idToken
 *
 * The member is signed out of Firebase again straight away: Firebase is only
 * the proof here, the venue's own session is what signs them in.
 */
class PhoneBridge(private val activity: Activity, messenger: BinaryMessenger) {
    private val auth: FirebaseAuth by lazy { FirebaseAuth.getInstance() }
    private var resend: PhoneAuthProvider.ForceResendingToken? = null
    private val channel = MethodChannel(messenger, "vesopa_loyalty/phone")

    init {
        channel.setMethodCallHandler { call, result ->
            when (call.method) {
                "start" -> start(call.argument<String>("phone").orEmpty(), result)
                "confirm" -> confirm(
                    call.argument<String>("verification").orEmpty(),
                    call.argument<String>("code").orEmpty(),
                    result,
                )
                else -> result.notImplemented()
            }
        }
    }

    private fun start(phone: String, result: MethodChannel.Result) {
        var answered = false
        fun once(block: () -> Unit) {
            if (!answered) {
                answered = true
                block()
            }
        }
        val callbacks = object : PhoneAuthProvider.OnVerificationStateChangedCallbacks() {
            override fun onVerificationCompleted(credential: PhoneAuthCredential) {
                // Read from the text after "code sent" was already answered:
                // Dart is told, so the member never has to type it (owner,
                // 2026-10-23: the code came but was not filled in).
                val late = answered
                tokenFor(credential) { token, error ->
                    if (late) {
                        if (token != null) channel.invokeMethod("proved", mapOf("token" to token, "code" to credential.smsCode))
                        return@tokenFor
                    }
                    once {
                        if (token != null) result.success(mapOf("token" to token))
                        else result.error("failed", error ?: "That number could not be checked.", null)
                    }
                }
            }

            override fun onVerificationFailed(e: FirebaseException) {
                // Firebase's own reason, said: there is no other texting
                // service to fall back on (owner, 2026-10-25).
                once { result.error("failed", friendly(e), null) }
            }

            override fun onCodeSent(id: String, token: PhoneAuthProvider.ForceResendingToken) {
                resend = token
                once { result.success(mapOf("verification" to id)) }
            }
        }
        val options = PhoneAuthOptions.newBuilder(auth)
            .setPhoneNumber(phone)
            .setTimeout(60L, TimeUnit.SECONDS)
            .setActivity(activity)
            .setCallbacks(callbacks)
            .apply { resend?.let { setForceResendingToken(it) } }
            .build()
        PhoneAuthProvider.verifyPhoneNumber(options)
    }

    private fun confirm(verification: String, code: String, result: MethodChannel.Result) {
        if (verification.isEmpty() || code.isEmpty()) {
            result.error("failed", "Enter the code from the text message.", null)
            return
        }
        tokenFor(PhoneAuthProvider.getCredential(verification, code)) { token, error ->
            if (token != null) result.success(token)
            else result.error("failed", error ?: "That code is not right. Please try again.", null)
        }
    }

    private fun tokenFor(credential: PhoneAuthCredential, done: (String?, String?) -> Unit) {
        auth.signInWithCredential(credential)
            .addOnSuccessListener { signedIn ->
                val user = signedIn.user
                if (user == null) {
                    done(null, null)
                    return@addOnSuccessListener
                }
                user.getIdToken(true)
                    .addOnSuccessListener { t ->
                        auth.signOut()
                        done(t.token, null)
                    }
                    .addOnFailureListener { e -> done(null, e.message) }
            }
            .addOnFailureListener { e -> done(null, friendly(e)) }
    }

    private fun friendly(e: Exception): String {
        val m = e.message.orEmpty()
        return when {
            m.contains("invalid", true) && m.contains("code", true) -> "That code is not right. Please try again."
            m.contains("format", true) || m.contains("phone number", true) -> "That does not look like a mobile number. Check the country and the number."
            m.contains("quota", true) || m.contains("too many", true) -> "Too many codes asked for. Please try again later."
            m.contains("not enabled", true) || m.contains("OPERATION_NOT_ALLOWED", true) -> "Phone sign-in is not switched on for this app yet."
            else -> "That number could not be checked just now (${e.javaClass.simpleName}). Please try again."
        }
    }
}
