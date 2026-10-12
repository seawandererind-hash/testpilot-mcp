import type { AppKind, AppType } from './schema.js';

export interface AppRef {
    kind: AppKind | 'help';
    ref: string;
    note?: string;
    guidance?: string;
}

const HELP_WORDS = /^(help|i don'?t (have|know)|no (apk|ipa|build|app)|none|not sure|\?)$/i;

const NO_BUILD_GUIDANCE: Partial<Record<AppType, string>> = {
    android:
        'No APK yet? Ask your Android developers for a debug build (Build → Build Bundle(s)/APK(s) → Build APK(s) in Android Studio, or `./gradlew assembleDebug`). A debug build is better for testing because WebViews can be inspected. Put it in the apps/ folder (git-ignored) and give me the path, or upload it to BrowserStack and give me the bs:// id.',
    ios: 'No IPA yet? Ask your iOS developers for a simulator build (.app, for local runs on a Mac) or an ad-hoc/development IPA signed for test devices (for real devices or BrowserStack). Put it in apps/ and give me the path, or give me a BrowserStack bs:// id.',
    'android-ios': 'Ask your developers for an Android debug APK and an iOS simulator .app or test IPA. Put them in apps/ and give me the paths.',
    hybrid: 'Ask for a debug build with WebView debugging enabled (setWebContentsDebuggingEnabled on Android, isInspectable on iOS), so tests can switch into the web parts.',
    windows: 'Give me the path to the installed .exe, or the installer. Developers can also give you a portable build.',
    macos: 'Give me the path to the .app bundle (usually in /Applications).'
};

/** Works out what kind of app reference the user gave. */
export function classifyAppRef(input: string, appType: AppType | undefined): AppRef {
    const value = input.trim().replace(/^["']|["']$/g, '');
    if (!value || HELP_WORDS.test(value)) {
        return { kind: 'help', ref: '', guidance: (appType && NO_BUILD_GUIDANCE[appType]) ?? 'Give me the URL of the test environment, a path to the app file, or a cloud app id.' };
    }
    if (/^https?:\/\//i.test(value)) {
        let note: string | undefined;
        try {
            const url = new URL(value);
            if (url.username || url.password) {
                return { kind: 'help', ref: '', guidance: 'Please give the address without a username or password in it. Logins go in .env (TEST_USER_EMAIL / TEST_USER_PASSWORD), never in chat.' };
            }
            const host = url.hostname;
            if (!/(test|stag|qa|uat|dev|sandbox|preprod|localhost|127\.0\.0\.1)/i.test(host)) {
                note = 'This address does not look like a test environment. Make sure it is not production; TestPilot refuses to run against production without an explicit flag.';
            }
        } catch {
            return { kind: 'help', ref: value, guidance: 'That URL could not be parsed. Use a full address such as https://staging.example.com.' };
        }
        if (/\.(json|ya?ml)$/i.test(value) && appType === 'api') return { kind: 'openapi', ref: value, note };
        return { kind: 'url', ref: value, note };
    }
    if (/^bs:\/\//i.test(value)) return { kind: 'cloud-id', ref: value, note: 'BrowserStack keeps uploaded apps for 30 days; re-upload after that.' };
    if (/^(sauce-storage:|lt:\/\/)/i.test(value)) return { kind: 'cloud-id', ref: value };
    const ext = value.toLowerCase().match(/\.(apk|aab|ipa|app|exe|msi|json|ya?ml)$/)?.[1];
    if (ext === 'apk' || ext === 'aab' || ext === 'ipa' || ext === 'app' || ext === 'exe') return { kind: ext, ref: value, note: 'Keep app binaries in the git-ignored apps/ folder and share them through your build system or BrowserStack.' };
    if (ext === 'msi') return { kind: 'exe', ref: value, note: 'This is an installer; install it, then point TestPilot at the installed .exe.' };
    if ((ext === 'json' || ext === 'yaml' || ext === 'yml') && appType === 'api') return { kind: 'openapi', ref: value };
    if (appType === 'electron') return { kind: 'electron-path', ref: value };
    if (/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*){1,}$/.test(value)) {
        return { kind: appType === 'ios' || appType === 'macos' ? 'bundle-id' : 'package-id', ref: value, note: 'An installed app id. Tests will start the app already installed on the device.' };
    }
    return { kind: 'help', ref: value, guidance: (appType && NO_BUILD_GUIDANCE[appType]) ?? 'I could not recognise that. Give a full URL (https://…), a file path ending in .apk/.ipa/.app/.exe, or a cloud id such as bs://….' };
}
