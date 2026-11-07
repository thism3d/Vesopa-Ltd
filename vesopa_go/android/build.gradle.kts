allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
// Play Console flags stripeterminal 5.6.0, which mek_stripe_terminal 5.7.3 still
// asks for: its offline database migration is bad, fixed in 5.7.0 (stripe-terminal-
// android #731). 5.8.2 is the newest of the 5.x line the plugin is written for;
// 6.0.0 is a new major and waits for the plugin. Drop this once the plugin moves.
subprojects {
    configurations.all {
        resolutionStrategy.eachDependency {
            if (requested.group == "com.stripe" && requested.name.startsWith("stripeterminal")) {
                useVersion("5.8.2")
                because("5.6.0 has a bad offline database migration")
            }
        }
    }
}
subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
