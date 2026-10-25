# Vesopa Loyalty (and every venue app made from it): R8 rules for the release.
#
# Firebase, Credential Manager and the Flutter plugins ship their own consumer
# rules, so only what is ours is kept here.

# The platform channels are found by name from Dart, not by reflection, but the
# bridge classes are registered from MainActivity: keep them and their members
# so a call never lands on a renamed method.
-keep class uk.co.vesopa.vesopa_loyalty.** { *; }

# Flutter's deferred components refer to Play Core, which this app does not
# include (no dynamic feature modules); without these R8 stops on the missing
# classes in full mode.
-dontwarn com.google.android.play.core.splitcompat.**
-dontwarn com.google.android.play.core.splitinstall.**
-dontwarn com.google.android.play.core.tasks.**

# Crash reports stay readable: keep file names and line numbers (the mapping
# file Play receives turns the obfuscated names back).
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
