import { cp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
const root = process.cwd(), android = join(root, 'android'), source = join(root, 'android-native'), app = join(android, 'app');
if (!existsSync(join(android, 'app', 'src', 'main', 'AndroidManifest.xml'))) throw new Error('Capacitor Android project is missing. Run npx cap add android first.');
await cp(join(source, 'src/main/java'), join(app, 'src/main/java'), { recursive: true, force: true });
await cp(join(source, 'src/main/cpp'), join(app, 'src/main/cpp'), { recursive: true, force: true });
await cp(join(source, 'src/main/res/xml'), join(app, 'src/main/res/xml'), { recursive: true, force: true });
const manifestPath = join(app, 'src/main/AndroidManifest.xml');
let manifest = await readFile(manifestPath, 'utf8');
const fragment = (await readFile(join(source, 'src/main/AndroidManifest.fragment.xml'), 'utf8')).trim();
for (const permission of fragment.split('\n').filter(line => line.startsWith('<uses-permission'))) {
  const name = permission.match(/android:name="([^"]+)"/)?.[1];
  if (name && !manifest.includes('android:name="' + name + '"')) manifest = manifest.replace(/<application\b/, permission + '\n    <application');
}
if (!manifest.includes('android:networkSecurityConfig=')) manifest = manifest.replace(/<application\b/, '<application android:networkSecurityConfig="@xml/axiom_network_security_config"');
if (!manifest.includes('com.axiom.mobile.AxiomRuntimeService')) {
  const service = fragment.slice(fragment.indexOf('<service'), fragment.lastIndexOf('</service>') + '</service>'.length);
  manifest = manifest.replace('</application>', service + '\n    </application>');
}
await writeFile(manifestPath, manifest);
const gradlePath = join(app, 'build.gradle');
if (!existsSync(gradlePath)) throw new Error('Expected Groovy app/build.gradle; Kotlin DSL is not supported.');
let gradle = await readFile(gradlePath, 'utf8');
if (!gradle.includes('org.jetbrains.kotlin.android')) {
  if (gradle.startsWith('plugins {')) gradle = gradle.replace('plugins {', "plugins {\n    id 'org.jetbrains.kotlin.android' version '2.1.20'");
  else {
    if (!gradle.includes("apply plugin: 'com.android.application'")) throw new Error('Could not locate the Android application plugin declaration.');
    gradle = gradle.replace("apply plugin: 'com.android.application'", "apply plugin: 'com.android.application'\napply plugin: 'org.jetbrains.kotlin.android'");
    const rootGradlePath = join(android, 'build.gradle');
    let rootGradle = await readFile(rootGradlePath, 'utf8');
    if (!rootGradle.includes('kotlin-gradle-plugin')) rootGradle = rootGradle.replace(/dependencies\s*\{/, "dependencies {\n        classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:2.1.20'");
    await writeFile(rootGradlePath, rootGradle);
  }
}
function insertBlock(sourceText, blockName, addition) {
  const start = sourceText.indexOf(blockName + ' {');
  if (start < 0) throw new Error('Could not locate ' + blockName + ' block.');
  let depth = 0, quote = null, escaped = false;
  for (let i = sourceText.indexOf('{', start); i < sourceText.length; i++) {
    const ch = sourceText[i];
    if (quote) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return sourceText.slice(0, i) + addition + '\n    ' + sourceText.slice(i);
  }
  throw new Error('Unbalanced Gradle block: ' + blockName);
}
if (!gradle.includes("abiFilters 'arm64-v8a'")) gradle = insertBlock(gradle, 'defaultConfig', "\n        ndk { abiFilters 'arm64-v8a' }");
if (!gradle.includes('src/main/cpp/CMakeLists.txt')) {
  gradle = insertBlock(gradle, 'defaultConfig', "\n        externalNativeBuild { cmake { cppFlags '-std=c++17' } }");
  gradle = insertBlock(gradle, 'android', "\n    externalNativeBuild { cmake { path file('src/main/cpp/CMakeLists.txt'); version '3.22.1' } }");
}
await writeFile(gradlePath, gradle);
const mainJava = join(app, 'src/main/java/com/axiom/mobile/MainActivity.java');
const mainKotlin = join(app, 'src/main/java/com/axiom/mobile/MainActivity.kt');
await mkdir(dirname(mainJava), { recursive: true });
if (existsSync(mainKotlin)) throw new Error('Unexpected Kotlin MainActivity exists; refusing to overwrite.');
const activity = 'package com.axiom.mobile;\n\nimport android.os.Bundle;\nimport com.getcapacitor.BridgeActivity;\n\npublic class MainActivity extends BridgeActivity {\n    @Override\n    public void onCreate(Bundle savedInstanceState) {\n        registerPlugin(AxiomRuntimePlugin.class);\n        registerPlugin(AxiomModelsPlugin.class);\n        super.onCreate(savedInstanceState);\n    }\n}\n';
await writeFile(mainJava, activity);
console.log('Installed Axiom native PTY, runtime service, and Capacitor plugin.');
