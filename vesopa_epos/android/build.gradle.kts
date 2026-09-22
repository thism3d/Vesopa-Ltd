allprojects {
    repositories {
        google()
        mavenCentral()

        // Dojo's card SDK is served from Cardinal Commerce's credentialed
        // Artifactory. Credentials are issued by Dojo to partners; supply them
        // via ~/.gradle/gradle.properties (never commit them):
        //
        //   cardinalRepoUsername=<from Dojo>
        //   cardinalRepoPassword=<from Dojo>
        //
        // The repo is only added when both are present, so a checkout without
        // the credentials still resolves every other dependency and builds.
        val cardinalUser = project.findProperty("cardinalRepoUsername") as String?
        val cardinalPass = project.findProperty("cardinalRepoPassword") as String?
        if (cardinalUser != null && cardinalPass != null) {
            maven {
                url = uri("https://cardinalcommerceprod.jfrog.io/artifactory/android")
                credentials {
                    username = cardinalUser
                    password = cardinalPass
                }
            }
        }
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
subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
