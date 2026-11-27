package com.vesopa.go

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel

/**
 * The venue's screens finding each other on the Wi-Fi by themselves (owner,
 * 2026-11-27: "use local connection to find out the TV"): DNS-SD (Bonjour), as
 * Google TV and Chromecast do. A TV running Kitchen or Customer display
 * announces "_vesopago._tcp" with its own little server's port
 * (lib/remote/go_remote.dart, LocalScreenServer) and its device id; a phone or
 * tablet browses for it and gets each one's address. Nothing secret is
 * announced: the key that lets a phone press keys still comes from Vesopa.
 */
class GoNsd(context: Context, messenger: BinaryMessenger) {
    private val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val channel = MethodChannel(messenger, "com.vesopa.go/nsd")
    private val main = Handler(Looper.getMainLooper())
    private var registration: NsdManager.RegistrationListener? = null
    private var discovery: NsdManager.DiscoveryListener? = null
    private val resolving = ArrayDeque<NsdServiceInfo>()
    private var busy = false

    init {
        channel.setMethodCallHandler { call, result ->
            try {
                when (call.method) {
                    "register" -> {
                        unregister()
                        val info = NsdServiceInfo().apply {
                            serviceName = "Vesopa Go ${call.argument<String>("name") ?: "Screen"}".take(60)
                            serviceType = TYPE
                            port = call.argument<Int>("port") ?: 0
                            setAttribute("id", call.argument<String>("id") ?: "")
                            setAttribute("mode", call.argument<String>("mode") ?: "")
                            setAttribute("name", (call.argument<String>("name") ?: "").take(60))
                        }
                        val l = object : NsdManager.RegistrationListener {
                            override fun onServiceRegistered(i: NsdServiceInfo) {}
                            override fun onRegistrationFailed(i: NsdServiceInfo, code: Int) { send("log", mapOf("line" to "announce failed ($code)")) }
                            override fun onServiceUnregistered(i: NsdServiceInfo) {}
                            override fun onUnregistrationFailed(i: NsdServiceInfo, code: Int) {}
                        }
                        registration = l
                        nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, l)
                        result.success(true)
                    }
                    "unregister" -> { unregister(); result.success(true) }
                    "discover" -> {
                        stopDiscovery()
                        val l = object : NsdManager.DiscoveryListener {
                            override fun onDiscoveryStarted(type: String) {}
                            override fun onServiceFound(s: NsdServiceInfo) { main.post { resolving.addLast(s); next() } }
                            override fun onServiceLost(s: NsdServiceInfo) { send("lost", mapOf("service" to s.serviceName)) }
                            override fun onDiscoveryStopped(type: String) {}
                            override fun onStartDiscoveryFailed(type: String, code: Int) { send("log", mapOf("line" to "search failed ($code)")) }
                            override fun onStopDiscoveryFailed(type: String, code: Int) {}
                        }
                        discovery = l
                        nsd.discoverServices(TYPE, NsdManager.PROTOCOL_DNS_SD, l)
                        result.success(true)
                    }
                    "stop" -> { stopDiscovery(); result.success(true) }
                    else -> result.notImplemented()
                }
            } catch (e: Exception) {
                result.error("nsd", e.message, null)
            }
        }
    }

    /** One at a time: NsdManager resolves a single service at once. */
    @Suppress("DEPRECATION")
    private fun next() {
        if (busy) return
        val s = resolving.removeFirstOrNull() ?: return
        busy = true
        nsd.resolveService(s, object : NsdManager.ResolveListener {
            override fun onResolveFailed(i: NsdServiceInfo, code: Int) {
                main.post { busy = false; next() }
            }
            override fun onServiceResolved(i: NsdServiceInfo) {
                val attrs = i.attributes.mapValues { (_, v) -> v?.let { String(it) } ?: "" }
                val host = i.host?.hostAddress ?: ""
                if (host.isNotEmpty() && !host.contains(':')) {
                    send("found", mapOf(
                        "id" to (attrs["id"] ?: ""), "name" to (attrs["name"] ?: ""), "mode" to (attrs["mode"] ?: ""),
                        "host" to host, "port" to i.port, "service" to i.serviceName,
                    ))
                }
                main.post { busy = false; next() }
            }
        })
    }

    private fun send(method: String, args: Map<String, Any>) = main.post { channel.invokeMethod(method, args) }

    private fun unregister() {
        registration?.let { try { nsd.unregisterService(it) } catch (_: Exception) {} }
        registration = null
    }

    private fun stopDiscovery() {
        discovery?.let { try { nsd.stopServiceDiscovery(it) } catch (_: Exception) {} }
        discovery = null
        resolving.clear()
        busy = false
    }

    companion object {
        const val TYPE = "_vesopago._tcp."
    }
}
