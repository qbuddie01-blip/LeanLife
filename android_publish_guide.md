# LeanLife Android App Compilation & Google Play Store Publishing Guide

This guide describes how to compile the native Android wrapper project we created and publish it to the Google Play Store.

---

## 📱 What We Have Set Up
We created a native Android wrapper project matching production specifications:
1. **Source Location:** [leanlife-android/ (Android Project)](file:///C:/Users/Administrator/.gemini/antigravity/scratch/leanlife-android/)
2. **WebView Core:** Implemented a full-screen, hardware-accelerated WebView in `MainActivity.kt` with JavaScript, DOM storage, and local file access enabled.
3. **Embedded Web Assets:** Deployed the full synchronized code (HTML, CSS, IndexedDB persist, and Supabase client) directly inside the native assets directory `app/src/main/assets/`.
4. **Permissions:** Configured `AndroidManifest.xml` to request active Internet permissions.

---

## 🛠️ Step 1: Open & Compile in Android Studio

Because compiling mobile apps requires Java, Gradle, and build platforms, the easiest way to compile and test the app is using **Android Studio** (which manages its own SDKs and Java runtimes automatically).

1. **Download Android Studio:** Download and install [Android Studio](https://developer.android.com/studio) on your machine.
2. **Open the Project:**
   - Launch Android Studio.
   - Click **Open** and select the folder:
     `C:\Users\Administrator\.gemini\antigravity\scratch\leanlife-android`
3. **Design custom App Icons (Adaptive Icons):**
   - In Android Studio, right-click the `app` folder -> **New** -> **Image Asset**.
   - In the **Icon Type** dropdown, select **Launcher Icons (Adaptive and Legacy)**.
   - Choose your logo in the **Path** box and scale it to fit within the safe zone ring. Click **Next** and **Finish**.
4. **Compile a Debug APK (For Local Testing):**
   - Connect your Android phone via USB (with Developer Mode & USB Debugging enabled) or start a Virtual Device Emulator.
   - Click the green **Run** play icon in the top toolbar to launch the app directly on your device.
   - Or click **Build** -> **Build Bundle(s) / APK(s)** -> **Build APK(s)** to generate a test installable `.apk` file.

---

## 🔐 Step 2: Generate Signed Release Android App Bundle (AAB)

Google Play Store requires apps to be compiled as an **Android App Bundle (.aab)** and signed with a cryptographic release key.

1. In Android Studio, click **Build** -> **Generate Signed Bundle / APK...**
2. Select **Android App Bundle** and click **Next**.
3. Under **Key store path**, click **Create new...** to create a new keystore (save it securely as it is required for future updates).
4. Fill in the passwords, key alias, and developer certificate details. Click **OK**.
5. Select **release** build variant and click **Create**.
6. Once finished, Android Studio will output your signed `.aab` file inside the `app/release/` folder.

---

## 🌐 Step 3: Publish to Google Play Store

To list the application on the Google Play Store:

1. **Register Developer Account:**
   - Go to the [Google Play Console](https://play.google.com/console).
   - Sign in with your Google Account and register as a developer (requires a one-time $25 registration fee).
2. **Create Application:**
   - In the dashboard, click **Create app**.
   - Enter your App name (**LeanLife**), default language, and select **App** (not Game) and **Free**.
3. **Complete Set Up Tasks:**
   - Google will guide you through setting up privacy policy URLs, content ratings, target audience (e.g. 18+), and news app declarations.
4. **Create a Production Release:**
   - Navigate to **Release** -> **Production** on the left menu.
   - Click **Create new release**.
   - Upload your signed `.aab` file from `app/release/`.
   - Write short release notes (e.g., "Initial launch of LeanLife Wellness Portal").
5. **Set Up Store Listing:**
   - Upload your high-resolution App Icon (512x512 PNG), Feature Graphic (1024x500 PNG), and mobile screenshots.
6. **Submit for Review:**
   - Click **Review and release** and submit the app. Google usually reviews new applications within 3 to 7 days.
