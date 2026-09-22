# Dojo card SDK + its Cardinal Commerce 3-D Secure dependencies. Required by
# Dojo's setup guide so R8/ProGuard does not strip classes the SDK loads
# reflectively. Harmless when the SDK is not bundled (dojo.sdk.enabled=false).
-keep class com.cardinalcommerce.dependencies.internal.bouncycastle.** { *; }
-keep class com.cardinalcommerce.dependencies.internal.nimbusds.** { *; }
-keep class tech.dojo.pay.** { *; }
-dontwarn com.cardinalcommerce.**


# This app reaches the SDK reflectively (see DojoPaymentHandler); keep our own
# handler and the Kotlin function interface used for the result callback.
-keep class com.vesopaepos.app.** { *; }
-keep class kotlin.jvm.functions.** { *; }
