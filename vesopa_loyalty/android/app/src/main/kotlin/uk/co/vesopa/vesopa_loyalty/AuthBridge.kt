package uk.co.vesopa.vesopa_loyalty

import android.app.Activity
import android.os.CancellationSignal
import androidx.credentials.CreateCredentialResponse
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel

/**
 * Signing in with what the phone already has: Android's own Credential Manager
 * sheet for Google accounts and passkeys. No web page and no web view (owner,
 * 2026-10-12). The Dart side is lib/platform/native_auth.dart; the iPhone's
 * half is ios/Runner/AuthBridge.swift, and both answer the same calls:
 *
 *   google         {serverClientId}  -> the Google id token, minted for that
 *                                       web client (auth.vesopa.com accepts it)
 *   passkeyGet     WebAuthn request JSON  -> the assertion as JSON
 *   passkeyCreate  WebAuthn creation JSON -> the attestation as JSON
 *
 * A cancel is the error code `cancelled`; no passkey for that site on this
 * phone is `none`. Google checks this app's package and signing key against
 * the Firebase project's Android app (the Play and upload SHA fingerprints),
 * and a passkey's site names the app in its own assetlinks.json.
 */
class AuthBridge(private val activity: Activity, messenger: BinaryMessenger) {
    private val manager = CredentialManager.create(activity)

    init {
        MethodChannel(messenger, "vesopa_loyalty/auth").setMethodCallHandler { call, result ->
            when (call.method) {
                "available" -> result.success(mapOf("apple" to false, "passkeys" to true))
                // What this phone is, for "Where you are signed in": maker and
                // model ("Samsung SM-S918B") and the Android version.
                "device" -> result.success(mapOf(
                    "model" to listOf(android.os.Build.MANUFACTURER, android.os.Build.MODEL)
                        .filter { it.isNotBlank() }
                        .let { p -> if (p.size == 2 && p[1].startsWith(p[0], ignoreCase = true)) listOf(p[1]) else p }
                        .joinToString(" ") { it.replaceFirstChar { c -> c.uppercase() } },
                    "system" to android.os.Build.VERSION.RELEASE,
                ))
                "google" -> google(call.argument<String>("serverClientId"), result)
                "passkeyGet" -> passkeyGet(call.arguments as? String, result)
                "passkeyCreate" -> passkeyCreate(call.arguments as? String, result)
                else -> result.notImplemented()
            }
        }
    }

    private fun google(serverClientId: String?, result: MethodChannel.Result) {
        if (serverClientId.isNullOrEmpty()) return bad(result)
        // The Sign in with Google button's own flow: every account on the
        // phone, and adding one, rather than only those used here before.
        val option = GetSignInWithGoogleOption.Builder(serverClientId).build()
        get(GetCredentialRequest.Builder().addCredentialOption(option).build(), result) { response ->
            val credential = response.credential
            if (credential is CustomCredential &&
                credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL
            ) {
                GoogleIdTokenCredential.createFrom(credential.data).idToken
            } else {
                null
            }
        }
    }

    private fun passkeyGet(json: String?, result: MethodChannel.Result) {
        if (json.isNullOrEmpty()) return bad(result)
        val request = GetCredentialRequest.Builder().addCredentialOption(GetPublicKeyCredentialOption(json)).build()
        get(request, result) { response ->
            (response.credential as? PublicKeyCredential)?.authenticationResponseJson
        }
    }

    private fun passkeyCreate(json: String?, result: MethodChannel.Result) {
        if (json.isNullOrEmpty()) return bad(result)
        manager.createCredentialAsync(
            activity,
            CreatePublicKeyCredentialRequest(json),
            CancellationSignal(),
            activity.mainExecutor,
            object : CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException> {
                override fun onResult(response: CreateCredentialResponse) {
                    val made = (response as? CreatePublicKeyCredentialResponse)?.registrationResponseJson
                    if (made == null) bad(result) else result.success(made)
                }

                override fun onError(e: CreateCredentialException) {
                    if (e is CreateCredentialCancellationException) {
                        result.error("cancelled", null, null)
                    } else {
                        result.error("failed", e.errorMessage?.toString() ?: "That passkey could not be made.", null)
                    }
                }
            },
        )
    }

    private fun get(
        request: GetCredentialRequest,
        result: MethodChannel.Result,
        read: (GetCredentialResponse) -> String?,
    ) {
        manager.getCredentialAsync(
            activity,
            request,
            CancellationSignal(),
            activity.mainExecutor,
            object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
                override fun onResult(response: GetCredentialResponse) {
                    val answer = try {
                        read(response)
                    } catch (_: Exception) {
                        null
                    }
                    if (answer == null) bad(result) else result.success(answer)
                }

                override fun onError(e: GetCredentialException) {
                    when (e) {
                        is GetCredentialCancellationException -> result.error("cancelled", null, null)
                        is NoCredentialException -> result.error("none", "There is no passkey or account for this on this phone.", null)
                        else -> result.error("failed", e.errorMessage?.toString() ?: "That sign-in could not be completed.", null)
                    }
                }
            },
        )
    }

    private fun bad(result: MethodChannel.Result) {
        result.error("failed", "That sign-in could not be completed.", null)
    }
}
