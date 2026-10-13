# The watch app (android/wear), shrunk by R8 in release.
#
# The services, the Tile and the complication are named in AndroidManifest.xml,
# so R8 keeps them by itself. Kept here: the Wearable Data Layer listener's
# callbacks (called by Google Play services by name) and line numbers, so
# Play's crash reports point at the right line once deobfuscated.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
-keep class * extends com.google.android.gms.wearable.WearableListenerService { *; }
-dontwarn com.google.errorprone.annotations.**
