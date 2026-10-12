import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { AppType, ExecutionTarget } from './schema.js';

const run = promisify(execFile);

export interface PrereqResult {
    name: string;
    required: boolean;
    found: boolean;
    version?: string;
    fix?: string;
    note?: string;
}

interface Check {
    name: string;
    command: string;
    args: string[];
    parse?: (output: string) => string | undefined;
    minMajor?: number;
    fix: Partial<Record<NodeJS.Platform | 'default', string>>;
}

const firstVersion = (output: string) => output.match(/(\d+\.\d+(\.\d+)?)/)?.[1];

const CHECKS: Record<string, Check> = {
    node: { name: 'Node.js 22.19+', command: 'node', args: ['--version'], minMajor: 22, fix: { default: 'Install Node.js 22 LTS or newer from https://nodejs.org (or with nvm: `nvm install 22`).' } },
    npm: { name: 'npm', command: 'npm', args: ['--version'], fix: { default: 'npm comes with Node.js; reinstall Node.js 22 LTS.' } },
    git: { name: 'Git', command: 'git', args: ['--version'], fix: { default: 'Install Git from https://git-scm.com/downloads.' } },
    java: { name: 'Java 17+ (JDK)', command: 'java', args: ['-version'], minMajor: 17, fix: { default: 'Install a JDK 17 or 21, e.g. Eclipse Temurin from https://adoptium.net, and set JAVA_HOME.' } },
    python: { name: 'Python 3.10+', command: process.platform === 'win32' ? 'python' : 'python3', args: ['--version'], fix: { default: 'Install Python 3.12 from https://python.org.' } },
    dotnet: { name: '.NET SDK 8+', command: 'dotnet', args: ['--version'], minMajor: 8, fix: { default: 'Install the .NET 8 SDK from https://dotnet.microsoft.com/download.' } },
    adb: { name: 'Android SDK (adb)', command: 'adb', args: ['version'], fix: { default: 'Install Android Studio, then add <sdk>/platform-tools to PATH and set ANDROID_HOME.' } },
    xcode: { name: 'Xcode', command: 'xcodebuild', args: ['-version'], fix: { darwin: 'Install Xcode from the App Store, then run `xcode-select --install`.', default: 'iOS simulators need a Mac with Xcode. Use BrowserStack for iOS from this computer.' } },
    appium: { name: 'Appium 3', command: process.platform === 'win32' ? 'appium.cmd' : 'appium', args: ['--version'], minMajor: 3, fix: { default: 'Run `npm install -g appium@3` then install a driver, e.g. `appium driver install uiautomator2`.' } },
    maven: { name: 'Maven', command: process.platform === 'win32' ? 'mvn.cmd' : 'mvn', args: ['-v'], fix: { default: 'Install Maven from https://maven.apache.org/install.html.' } }
};

async function probe(check: Check): Promise<{ found: boolean; version?: string; tooOld?: boolean }> {
    try {
        const { stdout, stderr } = await run(check.command, check.args, { timeout: 15_000, windowsHide: true, shell: process.platform === 'win32' });
        const version = (check.parse ?? firstVersion)(`${stdout}\n${stderr}`);
        const major = version ? Number(version.split('.')[0]) : undefined;
        if (check.name.startsWith('Node.js') && version) {
            const [maj, min] = version.split('.').map(Number);
            return { found: true, version, tooOld: maj < 22 || (maj === 22 && min < 19) };
        }
        return { found: true, version, tooOld: check.minMajor !== undefined && major !== undefined && major < check.minMajor };
    } catch {
        return { found: false };
    }
}

/** Which tools a given app type and framework need on this computer. */
export function checksFor(appType: AppType | undefined, framework: string | undefined, language: string | undefined, target: ExecutionTarget | undefined): Array<{ key: string; required: boolean; note?: string }> {
    const out: Array<{ key: string; required: boolean; note?: string }> = [
        { key: 'node', required: true },
        { key: 'npm', required: true },
        { key: 'git', required: true }
    ];
    const local = !target || target === 'local';
    if (language === 'java' || language === 'kotlin') out.push({ key: 'java', required: true }, { key: 'maven', required: false });
    if (language === 'python') out.push({ key: 'python', required: true });
    if (language === 'csharp') out.push({ key: 'dotnet', required: true });
    const mobile = appType && ['android', 'ios', 'android-ios', 'hybrid'].includes(appType);
    if (mobile || appType === 'windows' || appType === 'macos' || framework?.startsWith('appium')) {
        out.push({ key: 'appium', required: local, note: local ? undefined : 'Only needed for local runs.' });
    }
    if (appType === 'android' || appType === 'android-ios' || appType === 'hybrid') {
        out.push({ key: 'java', required: local }, { key: 'adb', required: local, note: local ? undefined : 'Only needed for local runs.' });
    }
    if (appType === 'ios' || appType === 'android-ios' || appType === 'macos') {
        out.push({ key: 'xcode', required: local && process.platform === 'darwin', note: process.platform === 'darwin' ? undefined : 'This computer is not a Mac, so iOS runs go to a device cloud such as BrowserStack.' });
    }
    // de-duplicate, keeping the strictest requirement
    const merged = new Map<string, { key: string; required: boolean; note?: string }>();
    for (const item of out) {
        const prev = merged.get(item.key);
        merged.set(item.key, prev ? { ...prev, required: prev.required || item.required } : item);
    }
    return [...merged.values()];
}

export async function checkPrerequisites(appType: AppType | undefined, framework: string | undefined, language: string | undefined, target: ExecutionTarget | undefined): Promise<{ results: PrereqResult[]; network: NetworkInfo; ok: boolean }> {
    const wanted = checksFor(appType, framework, language, target);
    const results = await Promise.all(
        wanted.map(async ({ key, required, note }) => {
            const check = CHECKS[key];
            const outcome = await probe(check);
            const fix = check.fix[process.platform] ?? check.fix.default;
            const result: PrereqResult = { name: check.name, required, found: outcome.found && !outcome.tooOld, version: outcome.version, note };
            if (!outcome.found) result.fix = fix;
            else if (outcome.tooOld) result.fix = `Version ${outcome.version} is too old. ${fix}`;
            return result;
        })
    );
    const network = await networkInfo();
    return { results, network, ok: results.every(r => r.found || !r.required) };
}

export interface NetworkInfo {
    proxy?: string;
    npmRegistry?: string;
    playwrightDownloadHost?: string;
    notes: string[];
}

/** Corporate laptops often sit behind a proxy and a private registry; report what is configured. */
async function networkInfo(): Promise<NetworkInfo> {
    const env = process.env;
    const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
    let npmRegistry: string | undefined;
    try {
        const { stdout } = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['config', 'get', 'registry'], { timeout: 10_000, shell: process.platform === 'win32' });
        npmRegistry = stdout.trim();
    } catch {
        // npm missing is reported by the npm check
    }
    const notes: string[] = [];
    if (proxy) notes.push('A proxy is configured. If browser downloads fail, set PLAYWRIGHT_DOWNLOAD_HOST to your internal mirror.');
    if (npmRegistry && !/registry\.npmjs\.org/.test(npmRegistry)) notes.push(`npm uses a private registry (${npmRegistry}). Make sure it mirrors @playwright/test and appium.`);
    return { proxy: proxy ? proxy.replace(/\/\/[^@/]+@/, '//') : undefined, npmRegistry, playwrightDownloadHost: env.PLAYWRIGHT_DOWNLOAD_HOST, notes };
}
