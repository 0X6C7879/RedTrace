---
name: cellular-pro-mumu-ad-sdk-fragment-fix
description: Cellular-Pro rebuilt APK on MuMu crashed first in third-party ad SDK anti-fraud paths, then in app fragments whose lifecycle methods had been stubbed without calling Fragment super methods.
metadata:
  type: project
---
Cellular-Pro rebuilt APK on MuMu 12 required a two-layer fix: first short-circuit third-party ad SDK device-fingerprint and ad-network paths that crashed under emulator translation, then restore Fragment lifecycle super-calls for app fragments that had been stubbed into no-ops.

**Why:** The privacy-consent crash was not a single issue. After the first native crash was removed, later startup phases exposed additional ad SDK emulator incompatibilities and finally an app-side `SuperNotCalledException` from fragments whose `onResume()` had been emptied.

**How to apply:** For rebuilt Android APKs that still crash only on MuMu/Android emulators after consent or splash, verify whether third-party ad SDK device-info collectors (e.g. `com.ad.sdk.fingerprint`, `com.ad.sdk.utils`, `com.ad.sdk.core.network`) need to be stubbed, then check app fragments for lifecycle methods replaced with `return-void` and restore direct `androidx.fragment.app.Fragment` super calls. Related: [[apk-reverse]], [[cellular-pro-reporting]].
